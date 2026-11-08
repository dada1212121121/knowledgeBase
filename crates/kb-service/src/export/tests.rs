use std::io::Read;

use super::*;

/// 把 tar.gz 读成 `(成员名, 内容)`:一个够用的 ustar 读取器(含 GNU `@LongLink`),不为测试加依赖。
fn read_archive(path: &Path) -> Vec<(String, Vec<u8>)> {
    let mut raw = Vec::new();
    flate2::read::GzDecoder::new(std::fs::File::open(path).unwrap())
        .read_to_end(&mut raw)
        .unwrap();
    let mut members = Vec::new();
    let mut offset = 0;
    let mut long_name: Option<String> = None;
    while offset + 512 <= raw.len() {
        let header = &raw[offset..offset + 512];
        if header.iter().all(|byte| *byte == 0) {
            break;
        }
        let text = |range: std::ops::Range<usize>| {
            String::from_utf8_lossy(&header[range])
                .trim_end_matches('\0')
                .trim()
                .to_owned()
        };
        let size = usize::from_str_radix(&text(124..136), 8).unwrap();
        let kind = header[156];
        let name = {
            let prefix = text(345..500);
            let base = text(0..100);
            if prefix.is_empty() {
                base
            } else {
                format!("{prefix}/{base}")
            }
        };
        offset += 512;
        let body = raw[offset..offset + size].to_vec();
        offset += size.div_ceil(512) * 512;
        if kind == b'L' {
            long_name = Some(
                String::from_utf8_lossy(&body)
                    .trim_end_matches('\0')
                    .to_owned(),
            );
            continue;
        }
        members.push((long_name.take().unwrap_or(name), body));
    }
    members
}

struct Tree {
    root: tempfile::TempDir,
}

impl Tree {
    fn new() -> Self {
        Self {
            root: tempfile::tempdir().unwrap(),
        }
    }
    fn sources(&self) -> PathBuf {
        self.root.path().join("home/sources")
    }
    fn put(&self, rel: &str, content: &[u8]) {
        let path = self.sources().join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }
    fn out(&self, name: &str) -> PathBuf {
        let dir = self.root.path().join("exports");
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }
}

fn export(tree: &Tree) -> (ExportPlan, Vec<(String, Vec<u8>)>) {
    let plan = plan_export(&tree.sources()).unwrap();
    let out = tree.out("export.tar.gz");
    write_export(
        &plan,
        &tree.sources(),
        &out,
        "alice",
        1_700_000_000_000,
        &mut |_| {},
    )
    .unwrap();
    let members = read_archive(&out);
    (plan, members)
}

fn names(members: &[(String, Vec<u8>)]) -> Vec<&str> {
    members.iter().map(|(name, _)| name.as_str()).collect()
}

#[test]
fn the_archive_holds_the_users_files_under_sources_with_a_manifest_first() {
    let tree = Tree::new();
    tree.put("paper.pdf", b"%PDF-1.7 fake");
    tree.put("notes/day1.md", "# 第一天\n内容".as_bytes());
    tree.put("notes/deep/er/day2.txt", b"two");
    let (plan, members) = export(&tree);
    assert_eq!(
        names(&members),
        [
            "manifest.json",
            "sources/notes/day1.md",
            "sources/notes/deep/er/day2.txt",
            "sources/paper.pdf"
        ]
    );
    assert_eq!(members[3].1, b"%PDF-1.7 fake");
    assert_eq!(members[1].1, "# 第一天\n内容".as_bytes(), "中文内容原样");
    let manifest: serde_json::Value = serde_json::from_slice(&members[0].1).unwrap();
    assert_eq!(manifest["kind"], "kb-personal-export");
    assert_eq!(
        (manifest["files"].as_u64(), manifest["owner"].as_str()),
        (Some(3), Some("alice"))
    );
    assert_eq!(manifest["total_bytes"].as_u64(), Some(plan.total_bytes));
    assert!(manifest["skipped"].as_array().unwrap().is_empty());
}

#[test]
fn nothing_outside_the_sources_directory_can_end_up_in_the_archive() {
    let tree = Tree::new();
    tree.put("mine.txt", b"mine");
    // 数据根目录里的敏感东西:主知识库的 sources 就在它下面,导出绝不能顺着往上走
    let home = tree.root.path().join("home");
    std::fs::write(home.join("config.toml"), b"[server]").unwrap();
    std::fs::write(home.join("secrets.toml"), b"api_key = \"sk-SECRET\"").unwrap();
    std::fs::write(home.join("system.db"), b"every user's account").unwrap();
    std::fs::create_dir_all(home.join("spaces/sp_bob")).unwrap();
    std::fs::write(home.join("spaces/sp_bob/meta.db"), b"bob's private notes").unwrap();
    let (_, members) = export(&tree);
    assert_eq!(names(&members), ["manifest.json", "sources/mine.txt"]);
    let everything: Vec<u8> = members.iter().flat_map(|(_, body)| body.clone()).collect();
    for needle in [
        &b"sk-SECRET"[..],
        b"every user",
        b"bob's private",
        b"[server]",
    ] {
        assert!(
            !everything.windows(needle.len()).any(|w| w == needle),
            "归档里不该出现 {:?}",
            String::from_utf8_lossy(needle)
        );
    }
}

#[test]
fn symlinks_are_never_followed_even_when_they_point_at_secrets() {
    let tree = Tree::new();
    tree.put("real.txt", b"real");
    let secret = tree.root.path().join("home/secrets.toml");
    std::fs::write(&secret, b"api_key = \"sk-SECRET\"").unwrap();
    std::os::unix::fs::symlink(&secret, tree.sources().join("innocent.txt")).unwrap();
    std::os::unix::fs::symlink(
        tree.root.path().join("home"),
        tree.sources().join("whole-home"),
    )
    .unwrap();
    std::os::unix::fs::symlink("/etc", tree.sources().join("etc")).unwrap();
    let (plan, members) = export(&tree);
    assert_eq!(names(&members), ["manifest.json", "sources/real.txt"]);
    assert_eq!(
        plan.skipped
            .iter()
            .filter(|line| line.contains("符号链接"))
            .count(),
        3,
        "{:?}",
        plan.skipped
    );
    let everything: Vec<u8> = members.iter().flat_map(|(_, body)| body.clone()).collect();
    assert!(!everything.windows(9).any(|w| w == b"sk-SECRET"));
}

#[test]
fn the_quarantine_and_every_dot_entry_stay_out() {
    let tree = Tree::new();
    tree.put("ok.txt", b"ok");
    tree.put(".quarantine/up_1/malware.exe", b"MZ evil");
    tree.put(".hidden", b"h");
    tree.put("sub/.git/config", b"g");
    tree.put("sub/.DS_Store", b"d");
    tree.put("sub/visible.txt", b"v");
    let (_, members) = export(&tree);
    assert_eq!(
        names(&members),
        ["manifest.json", "sources/ok.txt", "sources/sub/visible.txt"]
    );
}

#[test]
fn archive_member_names_never_contain_dotdot_or_absolute_paths() {
    let tree = Tree::new();
    // 文件名里带反斜杠和看起来像穿越的片段:在 Linux 上它们只是普通字符,不能被「修正」成真的穿越
    tree.put("a\\..\\..\\evil.txt", b"x");
    tree.put("..data", b"y");
    tree.put("dir/normal.txt", b"z");
    let (_, members) = export(&tree);
    for (name, _) in &members {
        assert!(!name.starts_with('/'), "{name}");
        assert!(!name.split('/').any(|part| part == ".."), "{name}");
    }
    // `..data` 以点开头,按规则被排除;反斜杠那个保留原样
    assert!(names(&members).contains(&"sources/a\\..\\..\\evil.txt"));
    assert!(!names(&members).iter().any(|name| name.contains("..data")));
}

#[test]
fn very_long_paths_and_non_ascii_names_survive() {
    let tree = Tree::new();
    // 单个路径分量不能超过 255 字节(系统限制),所以「长」要靠多层目录叠出来
    let layers: Vec<String> = (1..=8).map(|n| format!("第{n}层很长的目录名称")).collect();
    let dir = layers.join("/");
    tree.put(
        &format!("{dir}/文件 with spaces & 符号 (1).txt"),
        "内容".as_bytes(),
    );
    let (_, members) = export(&tree);
    let wanted = format!("sources/{dir}/文件 with spaces & 符号 (1).txt");
    assert!(
        wanted.len() > 100,
        "这个名字要长到触发 GNU LongLink:{} 字节",
        wanted.len()
    );
    assert_eq!(members[1].0, wanted);
    assert_eq!(members[1].1, "内容".as_bytes());
}

#[test]
fn names_that_are_not_valid_utf8_are_reported_not_silently_dropped() {
    use std::os::unix::ffi::OsStrExt;
    let tree = Tree::new();
    tree.put("fine.txt", b"ok");
    let bad = tree
        .sources()
        .join(std::ffi::OsStr::from_bytes(b"bad-\xff\xfe.txt"));
    std::fs::write(bad, b"x").unwrap();
    let (plan, members) = export(&tree);
    assert_eq!(names(&members), ["manifest.json", "sources/fine.txt"]);
    assert!(
        plan.skipped.iter().any(|line| line.contains("UTF-8")),
        "{:?}",
        plan.skipped
    );
    let manifest: serde_json::Value = serde_json::from_slice(&members[0].1).unwrap();
    assert_eq!(
        manifest["skipped"].as_array().unwrap().len(),
        1,
        "跳过的东西要写进 manifest,用户能看到"
    );
}

#[test]
fn an_empty_or_missing_directory_exports_an_empty_but_valid_archive() {
    let tree = Tree::new();
    // 目录根本不存在
    let plan = plan_export(&tree.sources()).unwrap();
    assert!(plan.files.is_empty() && plan.total_bytes == 0);
    let out = tree.out("empty.tar.gz");
    write_export(&plan, &tree.sources(), &out, "alice", 1, &mut |_| {}).unwrap();
    assert_eq!(names(&read_archive(&out)), ["manifest.json"]);
    // 目录存在但是空的
    std::fs::create_dir_all(tree.sources()).unwrap();
    assert!(plan_export(&tree.sources()).unwrap().files.is_empty());
}

#[test]
fn the_output_file_may_not_live_inside_the_directory_being_packed() {
    let tree = Tree::new();
    tree.put("a.txt", b"a");
    let plan = plan_export(&tree.sources()).unwrap();
    let inside = tree.sources().join("export.tar.gz");
    let error = write_export(&plan, &tree.sources(), &inside, "alice", 1, &mut |_| {}).unwrap_err();
    assert!(error.to_string().contains("不能放在"), "{error}");
    assert!(
        !inside.exists() && !tree.sources().join("export.tar.gz.part").exists(),
        "拒绝时不留任何文件"
    );
}

#[test]
fn a_failed_export_leaves_no_partial_file_and_a_good_one_leaves_no_part_file() {
    let tree = Tree::new();
    tree.put("a.txt", b"a");
    tree.put("b.txt", b"b");
    let plan = plan_export(&tree.sources()).unwrap();
    // 计划做完之后,有人把 b.txt 换成了符号链接:打包时要发现并中止
    std::fs::remove_file(tree.sources().join("b.txt")).unwrap();
    std::os::unix::fs::symlink("/etc/passwd", tree.sources().join("b.txt")).unwrap();
    let out = tree.out("bad.tar.gz");
    let error = write_export(&plan, &tree.sources(), &out, "alice", 1, &mut |_| {}).unwrap_err();
    assert!(error.to_string().contains("被改动"), "{error}");
    assert!(!out.exists(), "失败时不能留下一个残缺的导出文件");
    assert!(!tree.out("bad.tar.gz.part").exists(), "也不留临时文件");
    // 成功的那次:只有最终文件
    std::fs::remove_file(tree.sources().join("b.txt")).unwrap();
    tree.put("b.txt", b"b");
    let plan = plan_export(&tree.sources()).unwrap();
    let good = tree.out("good.tar.gz");
    write_export(&plan, &tree.sources(), &good, "alice", 1, &mut |_| {}).unwrap();
    assert!(good.exists() && !tree.out("good.tar.gz.part").exists());
}

#[test]
fn progress_reports_every_byte_of_every_file() {
    let tree = Tree::new();
    tree.put("big.bin", &vec![7u8; 300_000]);
    tree.put("small.txt", b"hello");
    let plan = plan_export(&tree.sources()).unwrap();
    let mut seen = 0u64;
    write_export(
        &plan,
        &tree.sources(),
        &tree.out("p.tar.gz"),
        "alice",
        1,
        &mut |delta| seen += delta,
    )
    .unwrap();
    assert_eq!(seen, 300_005, "进度条的总量要和文件总字节数一致");
    assert_eq!(plan.total_bytes, 300_005);
}

// ---------------------------------------------------------------- 笔记

use kb_core::model::{Insight, InsightKind, ItemStatus};

fn note(id: &str, collection: &str, title: &str, body: &str) -> Insight {
    Insight {
        id: id.to_owned(),
        collection: collection.to_owned(),
        title: title.to_owned(),
        body_md: body.to_owned(),
        kind: InsightKind::Howto,
        tags: vec!["a".to_owned(), "b:c".to_owned()],
        related_paths: vec!["src/lib.rs".to_owned()],
        status: ItemStatus::Active,
        version: 1,
        valid_from: 1_700_000_000_000,
        valid_until: None,
        superseded_by: None,
        created_by: "user".to_owned(),
        batch_id: None,
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_100_000,
    }
}

#[test]
fn notes_are_exported_with_front_matter_and_only_when_active() {
    let mut old = note("0192aaaa-old", "_global", "旧版", "旧内容");
    old.status = ItemStatus::Superseded;
    let mut dead = note("0192bbbb-dead", "_global", "废弃", "没用了");
    dead.status = ItemStatus::Deprecated;
    let live = note("0192cccc-live", "_global", "部署步骤", "第一步\n第二步\n\n");
    let (notes, skipped) = notes_to_entries(&[old, dead, live]);
    assert!(skipped.is_empty());
    assert_eq!(notes.len(), 1, "被取代、已废弃的是历史,不导出");
    assert_eq!(notes[0].name, "notes/_global/部署步骤-0192cccc.md");
    let text = String::from_utf8(notes[0].content.clone()).unwrap();
    assert!(
        text.starts_with("---\ntitle: \"部署步骤\"\nid: \"0192cccc-live\"\n"),
        "{text}"
    );
    assert!(text.contains("kind: \"howto\""), "{text}");
    assert!(text.contains("tags: [\"a\", \"b:c\"]"), "{text}");
    assert!(
        text.contains("created_at: \"2023-11-14T22:13:20Z\""),
        "{text}"
    );
    assert!(
        text.ends_with("---\n\n第一步\n第二步\n"),
        "正文原样,末尾只留一个换行:{text:?}"
    );
}

#[test]
fn hostile_titles_and_collections_cannot_escape_the_notes_directory() {
    let evil = [
        ("../../etc", "../../passwd"),
        ("a/b/c", "x\\y"),
        ("..", ".."),
        (".hidden", ".bashrc"),
        ("proj", "CON"),
        ("proj", "nul.txt"),
        ("proj", "line\nbreak\u{202E}rtl"),
        ("", ""),
        ("proj", &"很长的标题".repeat(60)),
    ];
    let insights: Vec<Insight> = evil
        .iter()
        .enumerate()
        .map(|(i, (collection, title))| note(&format!("id{i:02}xxxxxxxx"), collection, title, "x"))
        .collect();
    let (notes, _) = notes_to_entries(&insights);
    assert_eq!(notes.len(), evil.len());
    for note in &notes {
        let parts: Vec<&str> = note.name.split('/').collect();
        assert_eq!(parts.len(), 3, "固定三层 notes/<分组>/<文件>:{}", note.name);
        assert_eq!(parts[0], "notes");
        for part in &parts {
            assert!(!part.is_empty() && !part.starts_with('.'), "{}", note.name);
            assert!(
                !part.contains(['\\', ':', '\n', '\u{202E}']),
                "{}",
                note.name
            );
        }
        assert!(
            parts[2].ends_with(".md") && parts[2].len() <= 255,
            "{}",
            note.name
        );
    }
    let names: Vec<&str> = notes.iter().map(|note| note.name.as_str()).collect();
    assert!(
        names.iter().any(|name| name.contains("/_CON-")),
        "保留设备名被改写:{names:?}"
    );
}

#[test]
fn notes_with_the_same_title_do_not_overwrite_each_other() {
    let a = note("0192dddd-a", "p", "同名", "A");
    let b = note("0192dddd-b", "p", "同名", "B");
    let (notes, _) = notes_to_entries(&[a, b]);
    let names: std::collections::HashSet<&str> = notes.iter().map(|n| n.name.as_str()).collect();
    assert_eq!(names.len(), 2, "前 8 位相同也要分得开:{names:?}");
    // 大小写不同的名字在不区分大小写的磁盘上也会互相覆盖,同样要分开
    let c = note("ABCDEFGH-1", "p", "Same", "C");
    let d = note("abcdefgh-2", "p", "same", "D");
    let (notes, _) = notes_to_entries(&[c, d]);
    let lower: std::collections::HashSet<String> =
        notes.iter().map(|n| n.name.to_lowercase()).collect();
    assert_eq!(lower.len(), 2, "{notes:?}");
}

#[test]
fn a_title_full_of_yaml_syntax_stays_one_value_in_the_front_matter() {
    let mut tricky = note("0192eeee-x", "p", "a: b\n# c \"d\" - e", "正文");
    tricky.tags = vec!["x\ny".to_owned(), "]".to_owned()];
    let (notes, _) = notes_to_entries(&[tricky]);
    let text = String::from_utf8(notes[0].content.clone()).unwrap();
    // 前置元数据必须恰好是 `---` 开、`---` 收,中间每个键一行(换行被转义,不会多出行)
    let fence_lines = text.lines().filter(|line| *line == "---").count();
    assert_eq!(fence_lines, 2, "{text}");
    let title_line = text
        .lines()
        .find(|line| line.starts_with("title: "))
        .unwrap();
    let decoded: String = serde_json::from_str(title_line.trim_start_matches("title: ")).unwrap();
    assert_eq!(decoded, "a: b\n# c \"d\" - e");
    // 标签里的换行和括号同样被转义在一行里,不会提前结束数组
    let tags_line = text
        .lines()
        .find(|line| line.starts_with("tags: "))
        .unwrap();
    let tags: Vec<String> = serde_json::from_str(tags_line.trim_start_matches("tags: ")).unwrap();
    assert_eq!(tags, ["x\ny", "]"]);
}

#[test]
fn notes_over_the_cap_are_dropped_loudly_not_silently() {
    let insights: Vec<Insight> = (0..5)
        .map(|i| {
            note(
                &format!("0192{i:04}-n"),
                "p",
                &format!("t{i}"),
                &"字".repeat(100),
            )
        })
        .collect();
    let one = notes_to_entries(&insights[..1]).0[0].content.len() as u64;
    let (notes, skipped) = notes_to_entries_capped(&insights, one * 2 + 1);
    assert_eq!(notes.len(), 2);
    assert_eq!(skipped.len(), 1);
    assert!(skipped[0].contains("3 条没有收进来"), "{skipped:?}");
}

#[test]
fn the_archive_carries_notes_before_sources_and_progress_counts_both() {
    let tree = Tree::new();
    tree.put("paper.pdf", b"%PDF fake");
    let mut plan = plan_export(&tree.sources()).unwrap();
    let (notes, skipped) = notes_to_entries(&[note("0192ffff-z", "_global", "笔记一", "你好")]);
    let note_bytes: u64 = notes.iter().map(|n| n.content.len() as u64).sum();
    plan.add_notes(notes, skipped);
    assert_eq!(plan.total_bytes, 9 + note_bytes, "进度分母包含笔记");
    let out = tree.out("with-notes.tar.gz");
    let mut seen = 0u64;
    write_export(
        &plan,
        &tree.sources(),
        &out,
        "alice",
        1_700_000_000_000,
        &mut |d| seen += d,
    )
    .unwrap();
    assert_eq!(
        seen, plan.total_bytes,
        "进度回调合计等于分母,进度条能走到头"
    );
    let members = read_archive(&out);
    assert_eq!(
        names(&members),
        [
            "manifest.json",
            "notes/_global/笔记一-0192ffff.md",
            "sources/paper.pdf"
        ]
    );
    let manifest: serde_json::Value = serde_json::from_slice(&members[0].1).unwrap();
    assert_eq!(manifest["notes"], 1);
    assert_eq!(manifest["files"], 1);
}
