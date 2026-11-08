//! 第 5 步验收:CSV / TSV 表格编辑(保持编码、分隔符、引号、换行;只重嵌入改动的行;带版本和乐观锁)。

use std::sync::Arc;

use kb_core::ports::repo::{ChunkRepo, VersionRepo};
use kb_service::IndexService;
use kb_service::edit::FileEditService;
use kb_service::edit_csv::CsvEditRequest;
use kb_service::index::IndexOptions;
use kb_testkit::TestEnv;

use kb_extract::csv_edit::CsvOp;
use kb_extract::text_codec::{Encoding, encode};

const COLLECTION: &str = "_global";

struct Harness {
    env: TestEnv,
    edits: FileEditService,
    index: Arc<IndexService>,
}

impl Harness {
    async fn new() -> Self {
        let env = TestEnv::new().await;
        kb_service::CollectionService::new(
            env.meta.clone(),
            env.store.clone(),
            env.embedder.clone(),
        )
        .ensure_global()
        .await
        .expect("建 _global");
        let index = Arc::new(IndexService::new(
            env.meta.clone(),
            env.store.clone(),
            env.embedder.clone(),
            env.chunker.clone(),
            env.scanner.clone(),
            IndexOptions::default(),
        ));
        let edits = FileEditService::new(env.meta.clone(), index.clone(), env.paths());
        Self { env, edits, index }
    }

    fn write(&self, rel_path: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir = self.env.paths().sources_dir().join("csv-test");
        std::fs::create_dir_all(&dir).expect("建目录");
        let path = dir.join(rel_path);
        std::fs::write(&path, bytes).expect("写文件");
        path
    }

    /// 首次索引(模拟上传后的解析)。
    async fn index_once(&self, rel_path: &str, path: &std::path::Path) -> u64 {
        let collection =
            kb_core::ports::repo::CollectionRepo::get(self.env.meta.as_ref(), COLLECTION)
                .await
                .expect("取 collection")
                .expect("存在");
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
        self.index
            .index_entry_with("", &collection, &entry, &spec, 1)
            .await
            .expect("首次索引")
            .chunks as u64
    }

    fn request(&self, path: &str, ops: Vec<CsvOp>) -> CsvEditRequest {
        CsvEditRequest {
            collection: COLLECTION.to_owned(),
            path: path.to_owned(),
            ops,
            expected_version: None,
            expected_sha256: None,
            author: "tester".to_owned(),
        }
    }
}

fn set(row: usize, col: usize, value: &str) -> CsvOp {
    CsvOp::SetCell {
        row,
        col,
        value: value.to_owned(),
    }
}

/// 一张几十行的表,每行足够长,让每一行(或几行)自己成块。
fn big_table() -> String {
    let mut text = String::from("编号,名称,说明\r\n");
    for index in 1..=40 {
        text.push_str(&format!(
            "{index},物料{index},这是第 {index} 行的说明文字,用来保证表格按行分块后每块互不相同\r\n"
        ));
    }
    text
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn editing_one_cell_changes_only_that_cell_on_disk_and_creates_a_version() {
    let h = Harness::new().await;
    let original = b"id,name,note\r\n1,apple,\"red, sweet\"\r\n2,pear,green\r\n";
    let path = h.write("fruit.csv", original);
    h.index_once("fruit.csv", &path).await;

    let result = h
        .edits
        .edit_csv(h.request("fruit.csv", vec![set(1, 1, "APPLE")]))
        .await
        .expect("编辑");
    assert_eq!(result.version, 2, "基线是版本 1,这次是版本 2");
    assert!(result.changed);
    assert_eq!(
        std::fs::read(&path).expect("读回"),
        b"id,name,note\r\n1,APPLE,\"red, sweet\"\r\n2,pear,green\r\n",
        "只有那个格子变了"
    );
    assert_eq!(result.format.delimiter, ',');
    assert_eq!(result.format.encoding, "utf-8");

    // 版本历史:基线是改动前的内容
    let versions = h
        .edits
        .versions(COLLECTION, "fruit.csv", 10)
        .await
        .expect("版本");
    assert_eq!(versions.len(), 2);
    let baseline = versions
        .iter()
        .find(|version| version.version == 1)
        .expect("基线");
    assert_eq!(baseline.body.as_bytes(), original, "基线是改动前的内容");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn saving_without_changes_is_byte_identical_and_makes_no_version() {
    let h = Harness::new().await;
    let gbk = encode("名称;数量\r\n苹果;3", Encoding::Gb18030).expect("编码");
    let path = h.write("gbk.csv", &gbk);
    h.index_once("gbk.csv", &path).await;

    let result = h
        .edits
        .edit_csv(h.request("gbk.csv", vec![]))
        .await
        .expect("什么都不改");
    assert!(!result.changed);
    assert_eq!(result.version, 0, "没有产生版本");
    assert_eq!(std::fs::read(&path).expect("读回"), gbk);

    // 设成一样的值也不算改动
    let same = h
        .edits
        .edit_csv(h.request("gbk.csv", vec![set(1, 0, "苹果")]))
        .await
        .expect("改成一样的");
    assert!(!same.changed);
    assert_eq!(std::fs::read(&path).expect("读回"), gbk);
    assert!(
        VersionRepo::latest_version(
            h.env.meta.as_ref(),
            &FileEditService::item_id(COLLECTION, "gbk.csv")
        )
        .await
        .expect("版本")
            == 0
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_gbk_file_stays_gbk_with_its_delimiter_and_line_endings() {
    let h = Harness::new().await;
    let gbk = encode("名称;数量\r\n苹果;3\r\n梨;5", Encoding::Gb18030).expect("编码");
    let path = h.write("gbk.csv", &gbk);
    h.index_once("gbk.csv", &path).await;

    let result = h
        .edits
        .edit_csv(h.request("gbk.csv", vec![set(1, 1, "30"), set(2, 0, "雪梨")]))
        .await
        .expect("编辑");
    assert_eq!(result.format.encoding, "gb18030");
    assert_eq!(result.format.delimiter, ';');
    assert_eq!(result.format.newline, "crlf");
    assert!(!result.format.trailing_newline);
    assert_eq!(
        std::fs::read(&path).expect("读回"),
        encode("名称;数量\r\n苹果;30\r\n雪梨;5", Encoding::Gb18030).expect("编码"),
        "仍是 GBK,没有变成 UTF-8,分号和 CRLF 都在,末尾仍没有换行"
    );
    // 索引里的文字是按 GBK 解开的中文,不是乱码
    let ids: Vec<String> = ChunkRepo::by_path(h.env.meta.as_ref(), COLLECTION, "gbk.csv")
        .await
        .expect("块")
        .into_iter()
        .map(|meta| meta.id)
        .collect();
    assert!(!ids.is_empty());
    let collection = kb_core::ports::repo::CollectionRepo::get(h.env.meta.as_ref(), COLLECTION)
        .await
        .expect("取 collection")
        .expect("存在");
    let indexed: String = h
        .env
        .store
        .get(&collection.active_table, &ids)
        .await
        .expect("读向量行")
        .into_iter()
        .map(|row| row.text)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(indexed.contains("雪梨"), "{indexed}");
    assert!(!indexed.contains('\u{fffd}'), "不该有替换字符:{indexed}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn only_the_chunks_of_edited_rows_are_reembedded() {
    let h = Harness::new().await;
    let table = big_table();
    let path = h.write("big.csv", table.as_bytes());
    let chunks = h.index_once("big.csv", &path).await;
    assert!(chunks >= 2, "表格应按行分成多块:{chunks}");

    let result = h
        .edits
        .edit_csv(h.request("big.csv", vec![set(20, 2, "只改这一行的说明")]))
        .await
        .expect("编辑");
    assert!(result.embedded >= 1, "{result:?}");
    assert!(
        result.embedded < chunks,
        "只应重新嵌入改动那一行所在的块,不是全部:重嵌入 {} / 共 {chunks}",
        result.embedded
    );
    assert_eq!(
        ChunkRepo::by_path(h.env.meta.as_ref(), COLLECTION, "big.csv")
            .await
            .expect("块")
            .len() as u64,
        result.chunks
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stale_version_or_a_changed_file_is_a_conflict_not_an_overwrite() {
    let h = Harness::new().await;
    let path = h.write("c.csv", b"a,b\n1,2\n");
    h.index_once("c.csv", &path).await;
    let first = h
        .edits
        .edit_csv(h.request("c.csv", vec![set(1, 0, "10")]))
        .await
        .expect("第一次");

    // 拿着旧版本号
    let mut stale = h.request("c.csv", vec![set(1, 1, "20")]);
    stale.expected_version = Some(0);
    let error = h.edits.edit_csv(stale).await.expect_err("旧版本号");
    assert!(
        matches!(error, kb_core::KbError::Conflict { expected: 0, .. }),
        "{error}"
    );

    // 打开之后文件被别的方式改过(比如项目目录里被编辑器改了):内容哈希对不上也要拒绝
    let mut stale_hash = h.request("c.csv", vec![set(1, 1, "20")]);
    stale_hash.expected_sha256 = Some("0".repeat(64));
    let error = h.edits.edit_csv(stale_hash).await.expect_err("哈希不对");
    assert!(error.to_string().contains("已被改动"), "{error}");
    assert_eq!(
        std::fs::read(&path).expect("读回"),
        b"a,b\n10,2\n",
        "拒绝时文件不动"
    );

    // 最新的版本号和哈希就能存
    let mut ok = h.request("c.csv", vec![set(1, 1, "20")]);
    ok.expected_version = Some(first.version);
    ok.expected_sha256 = Some(first.sha256.clone());
    let saved = h.edits.edit_csv(ok).await.expect("最新的可以保存");
    assert_eq!(saved.version, first.version + 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rows_can_be_added_and_removed_and_the_edit_can_be_undone_by_restoring_the_baseline() {
    let h = Harness::new().await;
    let original = b"a,b\n1,2\n3,4\n";
    let path = h.write("rows.csv", original);
    h.index_once("rows.csv", &path).await;
    h.edits
        .edit_csv(h.request(
            "rows.csv",
            vec![
                CsvOp::DeleteRow { row: 1 },
                CsvOp::InsertRow {
                    at: 3,
                    values: vec!["5".to_owned(), "6".to_owned()],
                },
            ],
        ))
        .await
        .expect("编辑");
    assert_eq!(std::fs::read(&path).expect("读回"), b"a,b\n3,4\n5,6\n");

    // 把基线(版本 1)恢复回来:字节与原文件逐字节相同
    let versions = h
        .edits
        .versions(COLLECTION, "rows.csv", 10)
        .await
        .expect("版本");
    let baseline = versions.iter().find(|v| v.version == 1).expect("基线");
    h.edits.restore(&baseline.id, "tester").await.expect("恢复");
    assert_eq!(
        std::fs::read(&path).expect("读回"),
        original,
        "恢复后逐字节还原"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unreadable_or_oversized_or_non_csv_files_are_refused_and_left_alone() {
    let h = Harness::new().await;
    let bad = [b'a', b',', 0xFF, 0xFF];
    let path = h.write("bad.csv", &bad);
    let error = h
        .edits
        .edit_csv(h.request("bad.csv", vec![set(0, 0, "x")]))
        .await
        .expect_err("坏字节");
    assert!(error.to_string().contains("另存为 UTF-8"), "{error}");
    assert_eq!(std::fs::read(&path).expect("读回"), bad);

    h.write("note.md", b"# not a table\n");
    let error = h
        .edits
        .edit_csv(h.request("note.md", vec![]))
        .await
        .expect_err("不是表格");
    assert!(error.to_string().contains("CSV"), "{error}");

    let error = h
        .edits
        .edit_csv(h.request("../escape.csv", vec![]))
        .await
        .expect_err("路径不能越界");
    assert!(!error.to_string().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reading_a_page_reports_the_format_and_the_hash_to_send_back() {
    let h = Harness::new().await;
    let utf16 = encode("名称,数量\r\n苹果,3\r\n梨,5\r\n", Encoding::Utf16Le).expect("编码");
    h.write("u16.csv", &utf16);
    let page = h
        .edits
        .read_csv(COLLECTION, "u16.csv", 1, 10)
        .await
        .expect("读");
    assert_eq!(page.total_rows, 3);
    assert_eq!(page.rows, vec![vec!["苹果", "3"], vec!["梨", "5"]]);
    assert_eq!(page.columns, 2);
    assert_eq!(page.format.encoding, "utf-16le");
    assert_eq!(page.format.delimiter, ',');
    assert_eq!(page.sha256, kb_core::hash::sha256_hex_bytes(&utf16));
}
