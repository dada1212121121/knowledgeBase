//! 验收:文本在线编辑 + 版本历史。
//!
//! 断言三件事(与验收要求一致):
//! 1. **编辑 1 行只重嵌入受影响的块**(计数断言);
//! 2. **恢复旧版本 = 新版本**,且恢复后可再撤销;
//! 3. **并发编辑返回 409**(`KbError::Conflict`)。

use std::sync::Arc;

use kb_core::model::IngestState;
use kb_core::ports::repo::{ChunkRepo, VersionRepo};
use kb_service::IndexService;
use kb_service::edit::{FileEditService, SaveFileRequest};
use kb_service::index::IndexOptions;
use kb_testkit::TestEnv;

const COLLECTION: &str = "_global";

struct Harness {
    env: TestEnv,
    edits: FileEditService,
}

impl Harness {
    async fn new() -> Self {
        let env = TestEnv::new().await;
        let collections = kb_service::CollectionService::new(
            env.meta.clone(),
            env.store.clone(),
            env.embedder.clone(),
        );
        collections.ensure_global().await.expect("建 _global");
        let index = Arc::new(IndexService::new(
            env.meta.clone(),
            env.store.clone(),
            env.embedder.clone(),
            env.chunker.clone(),
            env.scanner.clone(),
            IndexOptions::default(),
        ));
        let edits = FileEditService::new(env.meta.clone(), index, env.paths());
        Self { env, edits }
    }

    /// 在数据源目录下放一个文件(模拟“上传 / 归档源写回 KB 存储”).
    fn write_source(&self, rel_path: &str, content: &str) -> std::path::PathBuf {
        let dir = self.env.paths().sources_dir().join("edit-test");
        std::fs::create_dir_all(&dir).expect("建目录");
        let path = dir.join(rel_path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("建父目录");
        }
        std::fs::write(&path, content).expect("写文件");
        path
    }
}

/// 首次索引一个文件(模拟上传后的解析)。
async fn index_once(harness: &Harness, rel_path: &str, path: &std::path::Path) -> u64 {
    let collection =
        kb_core::ports::repo::CollectionRepo::get(harness.env.meta.as_ref(), COLLECTION)
            .await
            .expect("取 collection")
            .expect("存在");
    let index = IndexService::new(
        harness.env.meta.clone(),
        harness.env.store.clone(),
        harness.env.embedder.clone(),
        harness.env.chunker.clone(),
        harness.env.scanner.clone(),
        IndexOptions::default(),
    );
    let metadata = std::fs::metadata(path).expect("元数据");
    let entry = kb_core::model::ScanEntry {
        path: path.to_path_buf(),
        relative: rel_path.to_owned(),
        size: metadata.len(),
        mtime: kb_service::index::millis_of(&metadata),
        lang: kb_index::lang::detect_lang(path).to_owned(),
        kind: kb_index::lang::kind_of(path),
    };
    let spec = kb_service::index::FileIndexSpec {
        source: rel_path.to_owned(),
        kind: entry.kind,
        tags: Vec::new(),
    };
    let stats = index
        .index_entry_with("", &collection, &entry, &spec, 1)
        .await
        .expect("首次索引");
    stats.chunks as u64
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn editing_one_line_only_reembeds_the_affected_chunk() {
    let harness = Harness::new().await;
    // 三个段落各自成块(空行分隔)
    // 每个标题下各一段:Markdown 分块器按标题分节,正好三块
    let mut body = String::new();
    for index in 1..=3 {
        body.push_str(&format!(
            "## 第 {index} 节\n\n第 {index} 段:这是一段足够长的正文,用来确保它自己成为一个块。\n\n"
        ));
    }
    let rel_path = "notes.md";
    let path = harness.write_source(rel_path, &body);
    let chunks = index_once(&harness, rel_path, &path).await;
    assert_eq!(chunks, 3, "三段应切成三块");

    // 只改第二段的一行
    let edited = body.replace("第 2 段:这是一段足够长的正文", "第 2 段:这一段被改过了");
    let result = harness
        .edits
        .save(SaveFileRequest {
            collection: COLLECTION.to_owned(),
            path: rel_path.to_owned(),
            content: edited.clone(),
            expected_version: None,
            author: "test".to_owned(),
            tags: Vec::new(),
        })
        .await
        .expect("保存");
    assert_eq!(result.embedded, 1, "只应重新嵌入 1 个块:{result:?}");
    assert_eq!(result.chunks, 3, "块数不变");
    assert_eq!(result.version, 2, "基线是版本 1,这次编辑是版本 2");

    // 内容落盘了
    let on_disk = std::fs::read_to_string(&path).expect("读回");
    assert_eq!(on_disk, edited);

    // 版本表里有这一版
    let versions = harness
        .edits
        .versions(COLLECTION, rel_path, 10)
        .await
        .expect("版本列表");
    assert_eq!(versions.len(), 2, "应有一条基线 + 一条编辑:{versions:?}");
    assert_eq!(versions[0].version, 2);
    assert_eq!(versions[0].body, edited);
    assert_eq!(versions[1].version, 1, "基线是改动前的内容");
    assert!(versions[1].body.contains("第 1 段"), "{:?}", versions[1]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn restoring_an_old_version_creates_a_new_version() {
    let harness = Harness::new().await;
    let rel_path = "log.txt";
    let v1 = "第一版内容。\n";
    let path = harness.write_source(rel_path, v1);
    index_once(&harness, rel_path, &path).await;

    let saved = harness
        .edits
        .save(SaveFileRequest {
            collection: COLLECTION.to_owned(),
            path: rel_path.to_owned(),
            content: "第二版内容。\n".to_owned(),
            expected_version: Some(0),
            author: "test".to_owned(),
            tags: Vec::new(),
        })
        .await
        .expect("保存第二版");
    assert_eq!(saved.version, 2, "基线 1 + 这次编辑 2");

    // 恢复到第一版(版本表里的第一条 = v1)
    let versions = harness
        .edits
        .versions(COLLECTION, rel_path, 10)
        .await
        .expect("版本列表");
    let first = versions.last().expect("第一版");
    let restored = harness
        .edits
        .restore(&first.id, "test")
        .await
        .expect("恢复");
    assert_eq!(restored.version, 3, "恢复本身是一个新版本");
    assert_eq!(
        std::fs::read_to_string(&path).expect("读回"),
        v1,
        "内容应回到第一版"
    );
    let versions = harness
        .edits
        .versions(COLLECTION, rel_path, 10)
        .await
        .expect("版本列表");
    assert_eq!(versions.len(), 3, "基线 + 第二版 + 恢复:{versions:?}");
    assert_eq!(versions[0].version, 3);
    assert_eq!(versions[1].version, 2);
    assert_eq!(versions[2].version, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stale_version_is_rejected_with_a_conflict() {
    let harness = Harness::new().await;
    let rel_path = "code.rs";
    let path = harness.write_source(rel_path, "fn main() {}\n");
    index_once(&harness, rel_path, &path).await;

    harness
        .edits
        .save(SaveFileRequest {
            collection: COLLECTION.to_owned(),
            path: rel_path.to_owned(),
            content: "fn main() { println!(\"v2\"); }\n".to_owned(),
            expected_version: Some(0),
            author: "alice".to_owned(),
            tags: Vec::new(),
        })
        .await
        .expect("第一次保存");

    // 拿着旧版本号再存一次:应冲突
    let error = harness
        .edits
        .save(SaveFileRequest {
            collection: COLLECTION.to_owned(),
            path: rel_path.to_owned(),
            content: "fn main() { println!(\"v3\"); }\n".to_owned(),
            expected_version: Some(0),
            author: "bob".to_owned(),
            tags: Vec::new(),
        })
        .await
        .expect_err("旧版本号应冲突");
    assert!(
        matches!(
            error,
            kb_core::KbError::Conflict {
                expected: 0,
                actual: 2
            }
        ),
        "{error}"
    );

    // 用最新版本号就能存
    let ok = harness
        .edits
        .save(SaveFileRequest {
            collection: COLLECTION.to_owned(),
            path: rel_path.to_owned(),
            content: "fn main() { println!(\"v3\"); }\n".to_owned(),
            expected_version: Some(2),
            author: "bob".to_owned(),
            tags: Vec::new(),
        })
        .await
        .expect("最新版本号可以保存");
    assert_eq!(ok.version, 3);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn saving_identical_content_creates_no_version() {
    let harness = Harness::new().await;
    let rel_path = "same.md";
    let path = harness.write_source(rel_path, "# 标题\n\n正文\n");
    index_once(&harness, rel_path, &path).await;

    let result = harness
        .edits
        .save(SaveFileRequest {
            collection: COLLECTION.to_owned(),
            path: rel_path.to_owned(),
            content: "# 标题\n\n正文\n".to_owned(),
            expected_version: None,
            author: "test".to_owned(),
            tags: Vec::new(),
        })
        .await
        .expect("保存");
    assert_eq!(result.embedded, 0, "内容没变不应重嵌入");
    assert_eq!(result.version, 0, "内容没变不生成版本");
    let versions = harness
        .edits
        .versions(COLLECTION, rel_path, 10)
        .await
        .expect("版本列表");
    assert!(versions.is_empty(), "{versions:?}");

    // 版本表确实没有数据(顺带验证 repo 的 latest_version)
    let latest = VersionRepo::latest_version(
        harness.env.meta.as_ref(),
        &FileEditService::item_id(COLLECTION, rel_path),
    )
    .await
    .expect("最新版本");
    assert_eq!(latest, 0);
    // 块还在
    let chunks = ChunkRepo::by_path(harness.env.meta.as_ref(), COLLECTION, rel_path)
        .await
        .expect("查块");
    assert!(!chunks.is_empty());
    let _ = IngestState::Done;
}

// ---------------------------------------------------------------- 安全审查 S-1:路径穿越

fn save_request(path: &str) -> SaveFileRequest {
    SaveFileRequest {
        collection: COLLECTION.to_owned(),
        path: path.to_owned(),
        content: "OVERWRITTEN BY ATTACKER".to_owned(),
        expected_version: None,
        author: "attacker".to_owned(),
        tags: Vec::new(),
    }
}

#[tokio::test]
async fn save_cannot_climb_out_of_the_sources_directory_or_use_absolute_paths() {
    let harness = Harness::new().await;
    // 数据源目录下至少有一个批次目录,「兜底在每个批次目录里找同名文件」才会被触发
    harness.write_source("ok.md", "正常文件\n");
    // 受害文件放在知识库的根目录:模拟别人的 meta.db / secrets.toml
    let victim = harness.env.paths().home().join("VICTIM-system.db");
    std::fs::write(&victim, "ORIGINAL SECRET CONTENT").unwrap();

    // sources/<批次>/../../VICTIM… 正好是 home 下的文件
    for attack in [
        "../../VICTIM-system.db",
        "../../../VICTIM-system.db",
        victim.to_str().unwrap(),
        "..\\..\\VICTIM-system.db",
    ] {
        let err = harness
            .edits
            .save(save_request(attack))
            .await
            .expect_err("穿越路径必须被拒绝");
        assert!(
            matches!(err, kb_core::KbError::InvalidInput(_)),
            "{attack}: {err}"
        );
    }
    assert_eq!(
        std::fs::read_to_string(&victim).unwrap(),
        "ORIGINAL SECRET CONTENT",
        "受害文件不能被改动"
    );
}

#[tokio::test]
async fn save_does_not_follow_a_symlink_that_points_outside() {
    let harness = Harness::new().await;
    harness.write_source("ok.md", "正常文件\n");
    let victim = harness.env.paths().home().join("VICTIM-via-link");
    std::fs::write(&victim, "ORIGINAL SECRET CONTENT").unwrap();
    // 上传的压缩包里可以带软链接:字符串上看是个普通的相对路径,真实位置在外面
    let batch = harness.env.paths().sources_dir().join("edit-test");
    std::os::unix::fs::symlink(&victim, batch.join("leak.md")).unwrap();

    let err = harness
        .edits
        .save(save_request("leak.md"))
        .await
        .expect_err("指到外面的软链接不能当成知识库里的文件");
    assert!(matches!(err, kb_core::KbError::NotFound(_)), "{err}");
    assert_eq!(
        std::fs::read_to_string(&victim).unwrap(),
        "ORIGINAL SECRET CONTENT"
    );
}

// ---------------------------------------------------------------- 保存按文件原来的编码写回

fn text_request(path: &str, content: &str) -> SaveFileRequest {
    SaveFileRequest {
        collection: COLLECTION.to_owned(),
        path: path.to_owned(),
        content: content.to_owned(),
        expected_version: None,
        author: "tester".to_owned(),
        tags: Vec::new(),
    }
}

fn write_bytes(harness: &Harness, rel_path: &str, bytes: &[u8]) -> std::path::PathBuf {
    let dir = harness.env.paths().sources_dir().join("edit-test");
    std::fs::create_dir_all(&dir).expect("建目录");
    let path = dir.join(rel_path);
    std::fs::write(&path, bytes).expect("写文件");
    path
}

/// 以前 `read_to_string` 读不出 GBK 就当成空文件,保存时再把整份写成 UTF-8,悄悄毁掉原文件。
/// 现在按文件原来的编码写回,基线版本也记下改动前的真实内容。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn saving_keeps_the_encoding_the_file_already_has() {
    let harness = Harness::new().await;
    let gbk = |text: &str| {
        kb_extract::text_codec::encode(text, kb_extract::text_codec::Encoding::Gb18030)
            .expect("编码")
    };
    let path = write_bytes(&harness, "gbk.txt", &gbk("第一行\n第二行\n"));
    let result = harness
        .edits
        .save(text_request("gbk.txt", "第一行\n改过的第二行\n"))
        .await
        .expect("保存");
    assert_eq!(result.version, 2);
    assert_eq!(
        std::fs::read(&path).expect("读回"),
        gbk("第一行\n改过的第二行\n"),
        "仍是 GBK"
    );
    let versions = harness
        .edits
        .versions(COLLECTION, "gbk.txt", 10)
        .await
        .expect("版本");
    let baseline = versions.iter().find(|v| v.version == 1).expect("基线");
    assert_eq!(
        baseline.body, "第一行\n第二行\n",
        "基线是改动前的真实内容,不是空串"
    );

    // 带 BOM 的 UTF-8:BOM 保留;旧版本记录里的文字开头带着 BOM 字符,恢复它们时不能出现两个 BOM
    let bom = write_bytes(&harness, "bom.txt", b"\xef\xbb\xbfold\n");
    harness
        .edits
        .save(text_request("bom.txt", "\u{feff}new\n"))
        .await
        .expect("保存");
    assert_eq!(std::fs::read(&bom).expect("读回"), b"\xef\xbb\xbfnew\n");
    harness
        .edits
        .save(text_request("bom.txt", "newer\n"))
        .await
        .expect("保存");
    assert_eq!(std::fs::read(&bom).expect("读回"), b"\xef\xbb\xbfnewer\n");

    // UTF-16LE
    let utf16 = |text: &str| {
        kb_extract::text_codec::encode(text, kb_extract::text_codec::Encoding::Utf16Le)
            .expect("编码")
    };
    let wide = write_bytes(&harness, "wide.txt", &utf16("甲\n乙\n"));
    harness
        .edits
        .save(text_request("wide.txt", "甲\n丙\n"))
        .await
        .expect("保存");
    assert_eq!(std::fs::read(&wide).expect("读回"), utf16("甲\n丙\n"));
}

/// 读不出文字的文件(不是任何受支持的编码)不去覆盖:报错,文件原样留着。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn saving_over_bytes_that_cannot_be_decoded_is_refused() {
    let harness = Harness::new().await;
    let original = [b'a', 0xFF, 0xFF, b'\n'];
    let path = write_bytes(&harness, "garbage.txt", &original);
    let error = harness
        .edits
        .save(text_request("garbage.txt", "替换\n"))
        .await
        .expect_err("不能覆盖读不出来的文件");
    assert!(error.to_string().contains("另存为 UTF-8"), "{error}");
    assert_eq!(std::fs::read(&path).expect("读回"), original);
}
