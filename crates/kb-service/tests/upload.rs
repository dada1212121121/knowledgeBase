//! 验收:分片续传、失败重试、秒传与三种同名策略、恶意 zip 隔离、批次撤销。
//!
//! 用真实的 SQLite / LanceDB(临时目录)+ FakeEmbedder,不碰真实 `~/.kb`。

use std::sync::Arc;

use kb_core::config::UploadConfig;
use kb_core::model::{
    Anchor, DedupStrategy, EdgeRel, IngestBatchState, IngestFile, IngestFilter, IngestState, Job,
    JobState, Page, SourceKind,
};
use kb_core::ports::repo::{
    ChunkRepo, CollectionRepo, EdgeRepo, FileRepo, IngestProgressRepo, IngestRepo, VersionRepo,
};
use kb_service::index::IndexOptions;
use kb_service::upload::unpack::UnpackLimits;
use kb_service::{
    AddSourceRequest, CompletedUpload, IndexService, IngestJobHandler, IngestPayload,
    IngestService, JobHandler, JobQueue, NewUpload, RevertService, SourceService, UploadService,
};
use kb_testkit::TestEnv;

const COLLECTION: &str = "_global";

/// 一套装好的上传 / 解析 / 撤销环境。
struct Harness {
    env: TestEnv,
    uploads: UploadService,
    /// 索引服务(可以再挂一个解析任务处理器,用来模拟“进程重启”)。
    index: Arc<IndexService>,
    paths: kb_core::paths::KbPaths,
    limits: UnpackLimits,
    tracker: Arc<kb_service::ProgressTracker>,
    ingest: IngestJobHandler,
    revert: RevertService,
    sources: SourceService,
    /// 解析任务的 collection 名。
    collection: String,
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
        let config = UploadConfig {
            chunk_mb: 1,
            ..UploadConfig::default()
        };
        let paths = env.paths();
        let uploads = UploadService::new(env.meta.clone(), paths.clone(), config.clone());
        let index = Arc::new(IndexService::new(
            env.meta.clone(),
            env.store.clone(),
            env.embedder.clone(),
            env.chunker.clone(),
            env.scanner.clone(),
            IndexOptions::default(),
        ));
        let limits = UnpackLimits {
            max_ratio: 10,
            max_depth: 3,
            max_files: 100,
            max_bytes: config.max_file_mb * 1024 * 1024,
            max_total_bytes: 0,
        };
        let tracker = Arc::new(kb_service::ProgressTracker::new(
            env.meta.clone(),
            "cpu-int8",
        ));
        let ingest = IngestJobHandler::new(
            index.clone(),
            env.meta.clone(),
            paths.clone(),
            limits,
            10,
            tracker.clone(),
        );
        let revert = RevertService::new(env.meta.clone(), env.store.clone(), env.embedder.clone());
        let sources = SourceService::new(
            env.meta.clone(),
            env.store.clone(),
            env.scanner.clone(),
            paths.clone(),
            config,
        );
        Self {
            env,
            uploads,
            index,
            paths,
            limits,
            tracker,
            ingest,
            revert,
            sources,
            collection: COLLECTION.to_owned(),
        }
    }

    /// 再建一个解析任务处理器(`slice_files` 可控)。
    ///
    /// 每个处理器只有自己的内存状态,所以“用另一个处理器接着跑”等价于进程重启后恢复任务。
    fn handler(&self, slice_files: usize) -> IngestJobHandler {
        IngestJobHandler::new(
            self.index.clone(),
            self.env.meta.clone(),
            self.paths.clone(),
            self.limits,
            slice_files,
            self.tracker.clone(),
        )
    }

    /// 按分片上传一份内容,返回完成结果。
    async fn upload(
        &self,
        name: &str,
        rel_path: Option<&str>,
        content: &[u8],
        strategy: Option<DedupStrategy>,
    ) -> CompletedUpload {
        let session = self
            .uploads
            .create(NewUpload {
                name: name.to_owned(),
                rel_path: rel_path.map(str::to_owned),
                size: content.len() as u64,
                sha256: Some(kb_core::hash::sha256_hex_bytes(content)),
                collection: self.collection.clone(),
                tags: Vec::new(),
                batch: None,
                strategy,
            })
            .await
            .expect("新建上传");
        for (index, part) in content.chunks(session.chunk_size as usize).enumerate() {
            self.uploads
                .put_part(&session.upload_id, index as u32, part.to_vec(), None)
                .await
                .expect("写分片");
        }
        self.uploads
            .complete("test", &session.upload_id)
            .await
            .expect("完成上传")
    }

    /// 跑完一个批次的解析任务。
    async fn run_ingest(&self, batch_id: &str) -> Vec<String> {
        self.run_ingest_with(&self.ingest, batch_id).await
    }

    /// 用指定的处理器跑完一个批次(换处理器 = 模拟进程重启)。
    async fn run_ingest_with(&self, handler: &IngestJobHandler, batch_id: &str) -> Vec<String> {
        let job = self.job_for(batch_id);
        let mut errors = Vec::new();
        for _ in 0..50 {
            let progress = handler.run_slice(&job).await.expect("跑解析分片");
            errors.extend(progress.errors.clone());
            if progress.finished {
                return errors;
            }
        }
        panic!("解析任务没有在 50 个分片内结束");
    }

    /// 只跑一个分片,返回(是否跑完, 失败列表)。
    async fn run_slice_once(
        &self,
        handler: &IngestJobHandler,
        batch_id: &str,
    ) -> (bool, Vec<String>) {
        let job = self.job_for(batch_id);
        let progress = handler.run_slice(&job).await.expect("跑解析分片");
        (progress.finished, progress.errors)
    }

    /// 批次对应的任务(处理器只读 payload)。
    fn job_for(&self, batch_id: &str) -> Job {
        let payload = IngestPayload {
            batch_id: batch_id.to_owned(),
            collection: self.collection.clone(),
        };
        Job {
            id: format!("job-{batch_id}"),
            kind: "ingest".to_owned(),
            collection: Some(self.collection.clone()),
            priority: 60,
            state: JobState::Queued,
            payload_json: serde_json::to_string(&payload).expect("序列化"),
            checkpoint_json: None,
            detail: None,
            progress_done: 0,
            progress_total: None,
            rate: None,
            error: None,
            created_at: 0,
            started_at: None,
            finished_at: None,
        }
    }

    /// 某个路径下块的位置锚点(从 LanceDB 读)。
    async fn chunk_anchors(&self, rel_path: &str) -> Vec<Option<Anchor>> {
        let collection = CollectionRepo::get(self.env.meta.as_ref(), &self.collection)
            .await
            .expect("取 collection")
            .expect("collection 存在");
        let chunks = ChunkRepo::by_path(self.env.meta.as_ref(), &self.collection, rel_path)
            .await
            .expect("查块");
        let ids: Vec<String> = chunks.iter().map(|chunk| chunk.id.clone()).collect();
        self.env
            .store
            .get(&collection.active_table, &ids)
            .await
            .expect("读向量行")
            .into_iter()
            .map(|row| row.anchor)
            .collect()
    }

    /// 某个路径下块的正文(从 LanceDB 读:验证落库的是正文而不是二进制)。
    async fn chunk_text(&self, rel_path: &str) -> String {
        let collection = CollectionRepo::get(self.env.meta.as_ref(), &self.collection)
            .await
            .expect("取 collection")
            .expect("collection 存在");
        let chunks = ChunkRepo::by_path(self.env.meta.as_ref(), &self.collection, rel_path)
            .await
            .expect("查块");
        let ids: Vec<String> = chunks.iter().map(|chunk| chunk.id.clone()).collect();
        let records = self
            .env
            .store
            .get(&collection.active_table, &ids)
            .await
            .expect("读向量行");
        records
            .iter()
            .map(|row| row.text.clone())
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// 某个批次下的文件。
    async fn batch_files(&self, batch_id: &str) -> Vec<IngestFile> {
        IngestRepo::list(
            self.env.meta.as_ref(),
            IngestFilter {
                collection: None,
                batch_id: Some(batch_id.to_owned()),
                source_id: None,
                state: None,
            },
            Page::new(200, 0),
        )
        .await
        .expect("列队列")
    }

    /// 某个路径下的块数(SQLite 与 LanceDB 都应一致)。
    async fn chunks_of(&self, rel_path: &str) -> (u64, u64) {
        let collection =
            kb_core::ports::repo::CollectionRepo::get(self.env.meta.as_ref(), &self.collection)
                .await
                .expect("取 collection")
                .expect("collection 存在");
        let chunks = ChunkRepo::by_path(self.env.meta.as_ref(), &self.collection, rel_path)
            .await
            .expect("查块");
        // 过滤条件只从 `Filter::to_sql` 来(不手写 SQL 片段)
        let filter = kb_core::filter::Filter {
            path_prefix: Some(rel_path.to_owned()),
            ..kb_core::filter::Filter::default()
        }
        .to_sql()
        .expect("生成过滤条件");
        let rows = self
            .env
            .store
            .count(&collection.active_table, filter.as_deref())
            .await
            .expect("数向量");
        (chunks.len() as u64, rows)
    }

    fn source_file(&self, rel_path: &str) -> std::path::PathBuf {
        // 上传落盘在 <KB_HOME>/sources/<source_id>/<rel_path>
        let dir = self.env.paths().sources_dir().to_path_buf();
        for entry in std::fs::read_dir(&dir).expect("读 sources 目录").flatten() {
            let candidate = entry.path().join(rel_path);
            if candidate.is_file() {
                return candidate;
            }
        }
        panic!("找不到落盘文件 {rel_path}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn resumes_after_a_disconnect_and_matches_the_hash() {
    let harness = Harness::new().await;
    let content = vec![7u8; 3 * 1024 * 1024 + 123];
    let session = harness
        .uploads
        .create(NewUpload {
            name: "big.bin".to_owned(),
            rel_path: Some("docs/big.bin".to_owned()),
            size: content.len() as u64,
            sha256: Some(kb_core::hash::sha256_hex_bytes(&content)),
            collection: COLLECTION.to_owned(),
            tags: Vec::new(),
            batch: None,
            strategy: None,
        })
        .await
        .expect("新建上传");
    assert_eq!(session.parts_total, 4, "3 MB + 123 字节按 1 MB 分 4 片");

    // 只传 0、2、3 三片,模拟“传到一半断网”
    let parts: Vec<&[u8]> = content.chunks(session.chunk_size as usize).collect();
    for index in [0usize, 2, 3] {
        harness
            .uploads
            .put_part(
                &session.upload_id,
                index as u32,
                parts[index].to_vec(),
                None,
            )
            .await
            .expect("写分片");
    }
    // 重连后:只补传缺的那一片
    let status = harness
        .uploads
        .status(&session.upload_id)
        .await
        .expect("续传信息");
    assert_eq!(status.received, vec![0, 2, 3]);
    let missing = harness
        .uploads
        .missing_parts(&session.upload_id)
        .await
        .expect("缺片");
    assert_eq!(missing, vec![1]);

    let completed = harness
        .uploads
        .complete("test", &session.upload_id)
        .await
        .expect_err("缺片时不能完成");
    assert!(completed.to_string().contains("还缺"), "{completed}");

    harness
        .uploads
        .put_part(&session.upload_id, 1, parts[1].to_vec(), None)
        .await
        .expect("补传分片");
    let completed = harness
        .uploads
        .complete("test", &session.upload_id)
        .await
        .expect("完成上传");
    assert_eq!(completed.files.len(), 1);
    let file = &completed.files[0];
    assert_eq!(
        file.sha256.as_deref(),
        Some(kb_core::hash::sha256_hex_bytes(&content).as_str()),
        "整体 sha256 必须与原文一致"
    );
    let stored = std::fs::read(harness.source_file("docs/big.bin")).expect("读落盘文件");
    assert_eq!(stored, content, "合并后的内容必须逐字节一致");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_failed_part_is_retried_three_times() {
    let harness = Harness::new().await;
    let content = vec![3u8; 2 * 1024 * 1024];
    let session = harness
        .uploads
        .create(NewUpload {
            name: "flaky.txt".to_owned(),
            rel_path: None,
            size: content.len() as u64,
            sha256: None,
            collection: COLLECTION.to_owned(),
            tags: Vec::new(),
            batch: None,
            strategy: None,
        })
        .await
        .expect("新建上传");

    // 前两次“网络失败”,第三次成功:重试策略正好 3 次
    let policy = kb_service::upload::RetryPolicy {
        attempts: 3,
        base_delay: std::time::Duration::from_millis(0),
    };
    let mut attempts = 0u32;
    let part = content[..session.chunk_size as usize].to_vec();
    let result = policy
        .run(|attempt| {
            attempts = attempt;
            let harness = &harness;
            let upload_id = session.upload_id.clone();
            let part = part.clone();
            async move {
                if attempt < 3 {
                    return Err("网络断了".to_owned());
                }
                harness
                    .uploads
                    .put_part(&upload_id, 0, part, None)
                    .await
                    .map_err(|err| err.to_string())
            }
        })
        .await;
    assert!(result.is_ok(), "第 3 次应成功:{result:?}");
    assert_eq!(attempts, 3);
    let status = harness
        .uploads
        .status(&session.upload_id)
        .await
        .expect("续传信息");
    assert_eq!(status.received, vec![0], "重试成功后分片应已落库");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_text_upload_starts_its_version_history() {
    let harness = Harness::new().await;
    let first = harness
        .upload(
            "guide.md",
            Some("docs/guide.md"),
            "# 指南\n\n原文\n".as_bytes(),
            None,
        )
        .await;
    harness.run_ingest(&first.batch_id).await;
    let versions =
        VersionRepo::list_by_source(harness.env.meta.as_ref(), COLLECTION, "docs/guide.md", 10)
            .await
            .expect("读版本");
    assert_eq!(versions.len(), 1, "入库就应落一条 v1");
    assert_eq!(versions[0].version, 1);
    assert_eq!(versions[0].body, "# 指南\n\n原文\n");
    assert_eq!(versions[0].author.as_deref(), Some("upload"));

    // 同名覆盖上传:新内容接在后面,不能拿旧 v1 冒充「当前」
    let second = harness
        .upload(
            "guide.md",
            Some("docs/guide.md"),
            "# 指南\n\n改过的\n".as_bytes(),
            Some(DedupStrategy::Overwrite),
        )
        .await;
    harness.run_ingest(&second.batch_id).await;
    let versions =
        VersionRepo::list_by_source(harness.env.meta.as_ref(), COLLECTION, "docs/guide.md", 10)
            .await
            .expect("读版本");
    assert_eq!(versions.len(), 2);
    assert_eq!(versions[0].version, 2);
    assert_eq!(versions[0].body, "# 指南\n\n改过的\n");
    // 版本接上了,索引也得是新正文(覆盖上传要真的重跑解析)
    assert!(
        ingested_text(&harness, "docs/guide.md")
            .await
            .contains("改过的"),
        "覆盖后应重新索引"
    );

    // 内容没变的重新解析(重试 / 秒传):不重复记
    let again = harness
        .upload(
            "guide.md",
            Some("docs/guide.md"),
            "# 指南\n\n改过的\n".as_bytes(),
            Some(DedupStrategy::Overwrite),
        )
        .await;
    harness.run_ingest(&again.batch_id).await;
    let versions =
        VersionRepo::list_by_source(harness.env.meta.as_ref(), COLLECTION, "docs/guide.md", 10)
            .await
            .expect("读版本");
    assert_eq!(versions.len(), 2, "内容一样就不该再记一条");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn identical_content_is_not_uploaded_or_indexed_twice() {
    let harness = Harness::new().await;
    let content = "# 标题\n\n同一份内容\n".as_bytes();
    let first = harness
        .upload("same.md", Some("docs/same.md"), content, None)
        .await;
    harness.run_ingest(&first.batch_id).await;
    let (chunks_before, rows_before) = harness.chunks_of("docs/same.md").await;
    assert!(chunks_before > 0 && rows_before > 0, "首次上传应已入库");

    // 预检:同内容 → 秒传
    let sha = kb_core::hash::sha256_hex_bytes(content);
    let precheck = kb_service::upload::dedup::DedupService::new(harness.env.meta.clone())
        .precheck(
            COLLECTION,
            &[kb_service::PrecheckItem {
                rel_path: "docs/same.md".to_owned(),
                size: content.len() as u64,
                sha256: sha.clone(),
            }],
        )
        .await
        .expect("预检");
    assert_eq!(
        precheck[0].status,
        kb_service::upload::dedup::PrecheckStatus::SameContent
    );

    // 客户端不再传字节:直接声明 + 完成
    let session = harness
        .uploads
        .create(NewUpload {
            name: "same.md".to_owned(),
            rel_path: Some("docs/same.md".to_owned()),
            size: content.len() as u64,
            sha256: Some(sha),
            collection: COLLECTION.to_owned(),
            tags: Vec::new(),
            batch: None,
            strategy: None,
        })
        .await
        .expect("新建上传");
    assert_eq!(
        session.dedup,
        kb_service::upload::dedup::PrecheckStatus::SameContent
    );
    let completed = harness
        .uploads
        .complete("test", &session.upload_id)
        .await
        .expect("完成上传");
    assert_eq!(completed.files.len(), 0, "秒传不应再入队");
    assert_eq!(completed.skipped.len(), 1);
    assert_eq!(completed.skipped[0].reason, "same_content");

    // 不重复入库:块数与向量数都没变
    let (chunks_after, rows_after) = harness.chunks_of("docs/same.md").await;
    assert_eq!((chunks_before, rows_before), (chunks_after, rows_after));
    let total = IngestRepo::count(
        harness.env.meta.as_ref(),
        IngestFilter {
            collection: None,
            batch_id: None,
            source_id: None,
            state: None,
        },
    )
    .await
    .expect("数队列");
    assert_eq!(total, 1, "ingest_files 里只应有第一次的那条");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn same_name_different_content_honours_all_three_strategies() {
    let harness = Harness::new().await;
    let first = harness
        .upload("note.md", Some("notes/note.md"), b"# v1\n", None)
        .await;
    harness.run_ingest(&first.batch_id).await;
    assert_eq!(
        std::fs::read(harness.source_file("notes/note.md")).expect("读"),
        b"# v1\n"
    );

    // 1) skip:不入库,内容保持 v1
    let skipped = harness
        .upload(
            "note.md",
            Some("notes/note.md"),
            b"# v2\n",
            Some(DedupStrategy::Skip),
        )
        .await;
    assert_eq!(skipped.skipped.len(), 1);
    assert_eq!(skipped.skipped[0].reason, "skip");
    assert_eq!(
        std::fs::read(harness.source_file("notes/note.md")).expect("读"),
        b"# v1\n",
        "skip 不应改动原文件"
    );

    // 2) keep_both:自动改名
    let kept = harness
        .upload(
            "note.md",
            Some("notes/note.md"),
            b"# v2\n",
            Some(DedupStrategy::KeepBoth),
        )
        .await;
    assert_eq!(kept.files.len(), 1);
    assert_eq!(kept.files[0].rel_path, "notes/note (2).md");
    harness.run_ingest(&kept.batch_id).await;
    assert_eq!(
        std::fs::read(harness.source_file("notes/note (2).md")).expect("读"),
        b"# v2\n"
    );

    // 3) overwrite:替换 + 可撤销还原
    let overwritten = harness
        .upload(
            "note.md",
            Some("notes/note.md"),
            b"# v3\n",
            Some(DedupStrategy::Overwrite),
        )
        .await;
    assert_eq!(overwritten.files.len(), 1);
    assert_eq!(overwritten.files[0].rel_path, "notes/note.md");
    harness.run_ingest(&overwritten.batch_id).await;
    assert_eq!(
        std::fs::read(harness.source_file("notes/note.md")).expect("读"),
        b"# v3\n",
        "overwrite 应替换内容"
    );

    // 撤销覆盖:内容回到 v1,并重新入队
    let report = harness
        .revert
        .revert(&overwritten.batch_id)
        .await
        .expect("撤销覆盖批次");
    assert!(
        report.reverted.iter().any(|op| op.op == "ingest.file"),
        "{report:?}"
    );
    assert_eq!(
        std::fs::read(harness.source_file("notes/note.md")).expect("读"),
        b"# v1\n",
        "撤销覆盖后应还原旧版本"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn malicious_archives_are_quarantined() {
    let harness = Harness::new().await;

    // 1) zip-slip:条目名带 ../
    let mut evil = Vec::new();
    let evil_zip = harness.env.home().join("evil.zip");
    kb_testkit::zip::write_zip(
        &evil_zip,
        &[("../escape.txt", kb_testkit::zip::Entry::stored(b"pwned"))],
    );
    evil.extend(std::fs::read(&evil_zip).expect("读 zip"));
    let completed = harness
        .upload("evil.zip", Some("evil.zip"), &evil, None)
        .await;
    harness.run_ingest(&completed.batch_id).await;
    let files = harness.batch_files(&completed.batch_id).await;
    let archive = files
        .iter()
        .find(|file| file.rel_path == "evil.zip")
        .unwrap();
    assert_eq!(
        archive.state,
        IngestState::Quarantined,
        "恶意压缩包应进隔离:{:?}",
        archive.error
    );
    assert!(
        archive
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("不安全"),
        "{:?}",
        archive.error
    );
    assert!(
        !harness.env.home().join("escape.txt").exists(),
        "不能把文件写到数据目录之外"
    );

    // 2) zip 炸弹:压缩比远超 10 倍
    let bomb_path = harness.env.home().join("bomb.zip");
    kb_testkit::zip::write_zip(
        &bomb_path,
        &[(
            "big.bin",
            kb_testkit::zip::Entry::deflate(&vec![0u8; 4 * 1024 * 1024]),
        )],
    );
    let bomb = std::fs::read(&bomb_path).expect("读 zip");
    let completed = harness
        .upload("bomb.zip", Some("bomb.zip"), &bomb, None)
        .await;
    harness.run_ingest(&completed.batch_id).await;
    let files = harness.batch_files(&completed.batch_id).await;
    let archive = files
        .iter()
        .find(|file| file.rel_path == "bomb.zip")
        .unwrap();
    assert_eq!(
        archive.state,
        IngestState::Quarantined,
        "{:?}",
        archive.error
    );

    // 隔离之后可以释放回队列;释放必须把字节从隔离区挪回原位,
    // 否则重跑时解析拿到的是“文件不存在”
    let service = IngestService::new(harness.env.meta.clone());
    let released = service
        .release_quarantine(&archive.id)
        .await
        .expect("释放隔离");
    assert_eq!(released.state, IngestState::Queued);
    assert!(
        std::path::Path::new(&released.abs_path).exists(),
        "释放后原件要回到原位:{}",
        released.abs_path
    );
    // 批次上个回合已经 done:不拨回 running,后面投出去的任务会在 `run_slice` 开头
    // 判定“批次已结束”直接收尾,文件永远停在 queued
    let batch = IngestProgressRepo::ingest_batch(harness.env.meta.as_ref(), &completed.batch_id)
        .await
        .expect("取批次")
        .expect("批次存在");
    assert_eq!(batch.state, IngestBatchState::Running, "释放隔离要重开批次");
    // 并且这次任务真的动了一个文件(空转的话 done 会是 0)
    let job = harness.job_for(&completed.batch_id);
    let progress = harness.ingest.run_slice(&job).await.expect("再跑一片解析");
    assert_eq!(progress.done, 1, "释放之后要重新解析这个文件,而不是空转");
}

/// 「重试」对一批已经跑完的文件要真的重跑。
///
/// 回归:重试只把文件拨回 `queued`、投一个解析任务,而任务 `run_slice` 一开头就看批次状态,
/// `done` 直接收尾 —— 用户点了重试,文件永远停在 `queued`、块数一直是 0。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn retrying_a_finished_batch_reruns_it_instead_of_nopping() {
    let harness = Harness::new().await;
    let content = "# 重试\n\n这段正文要等重试之后才入索引。\n".as_bytes();
    let completed = harness
        .upload("retry.md", Some("retry/retry.md"), content, None)
        .await;
    harness.run_ingest(&completed.batch_id).await;
    let file = harness
        .batch_files(&completed.batch_id)
        .await
        .into_iter()
        .next()
        .expect("批次里有文件");
    assert_eq!(file.state, IngestState::Done);

    let service = IngestService::new(harness.env.meta.clone());
    // 先把它记成失败(界面上“重试”就是这么用),重试要把批次一并拨回 running
    IngestRepo::set_state(
        harness.env.meta.as_ref(),
        &file.id,
        IngestState::Failed,
        Some("测试:人为失败"),
    )
    .await
    .expect("标失败");
    let report = service
        .retry(std::slice::from_ref(&file.id))
        .await
        .expect("重试");
    assert_eq!(report.requeued, vec![file.id.clone()], "{report:?}");
    assert!(report.job_id.is_some(), "要投一条解析任务:{report:?}");
    let batch = IngestProgressRepo::ingest_batch(harness.env.meta.as_ref(), &completed.batch_id)
        .await
        .expect("取批次")
        .expect("批次存在");
    assert_eq!(batch.state, IngestBatchState::Running, "重试要重开批次");

    let job = harness.job_for(&completed.batch_id);
    let progress = harness.ingest.run_slice(&job).await.expect("跑解析分片");
    assert_eq!(
        progress.done, 1,
        "重试之后要真的重跑:{} 个文件",
        progress.done
    );
    let after = harness.batch_files(&completed.batch_id).await;
    assert_eq!(after[0].state, IngestState::Done);
    let (chunks, rows) = harness.chunks_of("retry/retry.md").await;
    assert!(chunks > 0, "重跑之后要有块");
    assert_eq!(chunks, rows);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reverting_a_batch_clears_files_chunks_and_vectors() {
    let harness = Harness::new().await;
    let content = "# 待撤销\n\n正文若干。\n".as_bytes();
    let completed = harness
        .upload("undo.md", Some("undo/undo.md"), content, None)
        .await;
    harness.run_ingest(&completed.batch_id).await;
    let (chunks, rows) = harness.chunks_of("undo/undo.md").await;
    assert!(chunks > 0, "解析后应有块");
    assert_eq!(chunks, rows, "SQLite 与 LanceDB 的块数应一致");
    let stored = harness.source_file("undo/undo.md");
    assert!(stored.is_file());

    let report = harness
        .revert
        .revert(&completed.batch_id)
        .await
        .expect("撤销批次");
    assert!(
        report.reverted.iter().any(|op| op.op == "ingest.file"),
        "{report:?}"
    );

    // 块、向量、files 行、ingest 行、磁盘字节全部清干净
    let (chunks_after, rows_after) = harness.chunks_of("undo/undo.md").await;
    assert_eq!((chunks_after, rows_after), (0, 0));
    assert!(
        FileRepo::get(harness.env.meta.as_ref(), COLLECTION, "undo/undo.md")
            .await
            .expect("查 files")
            .is_none(),
        "files 行应被删掉"
    );
    assert!(
        IngestRepo::get_by_path(harness.env.meta.as_ref(), COLLECTION, "undo/undo.md")
            .await
            .expect("查 ingest")
            .is_none(),
        "ingest_files 行应被删掉"
    );
    assert!(!stored.exists(), "磁盘上的文件应被删掉");
    // 再撤销一次应报错(幂等性由批次状态保证)
    assert!(harness.revert.revert(&completed.batch_id).await.is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn local_directory_source_is_scanned_and_indexed() {
    let harness = Harness::new().await;
    let dir = tempfile::tempdir().expect("临时目录");
    std::fs::create_dir_all(dir.path().join("sub")).expect("建目录");
    std::fs::write(dir.path().join("a.md"), "# 甲\n\n内容甲\n").expect("写");
    std::fs::write(dir.path().join("sub/b.md"), "# 乙\n\n内容乙\n").expect("写");
    std::fs::write(dir.path().join("skip.bin"), [0u8, 1, 2, 3]).expect("写二进制");

    let source = harness
        .sources
        .add(AddSourceRequest {
            kind: Some(SourceKind::LocalDir.as_str().to_owned()),
            name: Some("本地资料".to_owned()),
            uri: Some(dir.path().display().to_string()),
            collection: Some(COLLECTION.to_owned()),
            ..AddSourceRequest::default()
        })
        .await
        .expect("添加数据源");
    assert_eq!(source.kind, SourceKind::LocalDir);

    let outcome = harness
        .sources
        .sync("test", &source.id)
        .await
        .expect("同步");
    assert!(outcome.queued >= 2, "应把两个文本文件入队:{outcome:?}");
    harness.run_ingest(&outcome.batch_id).await;

    let files = harness.batch_files(&outcome.batch_id).await;
    let done: Vec<&IngestFile> = files
        .iter()
        .filter(|file| file.state == IngestState::Done)
        .collect();
    assert!(
        done.iter().any(|file| file.rel_path == "a.md"),
        "a.md 应已入库:{files:?}"
    );
    assert!(
        done.iter().any(|file| file.rel_path == "sub/b.md"),
        "子目录文件应保留相对路径:{files:?}"
    );
    let (chunks, rows) = harness.chunks_of("a.md").await;
    assert!(chunks > 0 && rows > 0);

    // 移除数据源:块与队列行一起清掉
    let removed = harness
        .sources
        .remove(&source.id)
        .await
        .expect("移除数据源");
    assert!(removed.files >= 2, "{removed:?}");
    assert!(removed.chunks > 0, "{removed:?}");
    let (chunks_after, rows_after) = harness.chunks_of("a.md").await;
    assert_eq!((chunks_after, rows_after), (0, 0));
    // 本地目录只移除索引：源目录里的文件必须原样保留（旧实现会删掉它们）。
    assert!(
        dir.path().join("a.md").is_file(),
        "移除本地目录数据源不能删除源文件"
    );
    assert!(
        dir.path().join("sub/b.md").is_file(),
        "移除本地目录数据源不能删除子目录文件"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_note_source_becomes_a_markdown_item() {
    let harness = Harness::new().await;
    let source = harness
        .sources
        .add(AddSourceRequest {
            kind: Some(SourceKind::Note.as_str().to_owned()),
            name: Some("随手记".to_owned()),
            uri: Some("# 灵感\n\n用分片续传省流量。\n".to_owned()),
            collection: Some(COLLECTION.to_owned()),
            ..AddSourceRequest::default()
        })
        .await
        .expect("添加笔记数据源");
    let outcome = harness
        .sources
        .sync("test", &source.id)
        .await
        .expect("同步");
    assert_eq!(outcome.queued, 1);
    harness.run_ingest(&outcome.batch_id).await;
    let (chunks, rows) = harness.chunks_of("note.md").await;
    assert!(chunks > 0, "笔记应能检索到");
    assert_eq!(chunks, rows);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_folder_upload_shares_one_batch() {
    let harness = Harness::new().await;
    let batch = "folder-batch-1";
    let mut batches = Vec::new();
    for (index, name) in ["one.md", "two.md"].iter().enumerate() {
        let content = format!("# 文件 {index}\n\n内容\n");
        let session = harness
            .uploads
            .create(NewUpload {
                name: (*name).to_owned(),
                rel_path: Some(format!("folder/{name}")),
                size: content.len() as u64,
                sha256: Some(kb_core::hash::sha256_hex_bytes(content.as_bytes())),
                collection: COLLECTION.to_owned(),
                tags: Vec::new(),
                batch: Some(batch.to_owned()),
                strategy: None,
            })
            .await
            .expect("新建上传");
        assert_eq!(session.batch_id, batch, "同一个文件夹共用一个批次");
        harness
            .uploads
            .put_part(&session.upload_id, 0, content.as_bytes().to_vec(), None)
            .await
            .expect("写分片");
        let completed = harness
            .uploads
            .complete("test", &session.upload_id)
            .await
            .expect("完成上传");
        batches.push(completed.batch_id);
    }
    assert_eq!(batches, vec![batch.to_owned(), batch.to_owned()]);
    harness.run_ingest(batch).await;
    let files = harness.batch_files(batch).await;
    assert_eq!(files.len(), 2, "一个批次里应有两条文件记录:{files:?}");
    assert!(files.iter().all(|file| file.state == IngestState::Done));

    // 撤销整批:两个文件一起清掉
    harness.revert.revert(batch).await.expect("撤销整批");
    assert!(harness.batch_files(batch).await.is_empty());
    for path in ["folder/one.md", "folder/two.md"] {
        let (chunks, rows) = harness.chunks_of(path).await;
        assert_eq!((chunks, rows), (0, 0), "{path} 应被清干净");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn stale_uploads_are_cleaned_up_after_the_keep_window() {
    let harness = Harness::new().await;
    let session = harness
        .uploads
        .create(NewUpload {
            name: "abandoned.md".to_owned(),
            rel_path: None,
            size: 16,
            sha256: None,
            collection: COLLECTION.to_owned(),
            tags: Vec::new(),
            batch: None,
            strategy: None,
        })
        .await
        .expect("新建上传");
    harness
        .uploads
        .put_part(&session.upload_id, 0, vec![1u8; 16], None)
        .await
        .expect("写分片");
    let upload_dir = harness.env.paths().upload_dir(&session.upload_id);
    assert!(upload_dir.is_dir());

    // 把 updated_at 拨到 25 小时前
    let mut upload = harness
        .uploads
        .upload(&session.upload_id)
        .await
        .expect("取上传");
    let now = 1_800_000_000_000i64;
    upload.updated_at = now - 25 * 3_600_000;
    kb_core::ports::repo::UploadRepo::update(harness.env.meta.as_ref(), upload.clone())
        .await
        .expect("改时间");

    // 保留窗口内不清理
    assert_eq!(
        harness
            .uploads
            .cleanup_stale(now - 3_600_000)
            .await
            .unwrap(),
        0
    );
    // 超过 24 小时清理
    assert_eq!(harness.uploads.cleanup_stale(now).await.unwrap(), 1);
    let cleaned = harness
        .uploads
        .upload(&session.upload_id)
        .await
        .expect("取上传");
    assert_eq!(cleaned.state, kb_core::model::UploadState::Aborted);
    assert!(!upload_dir.exists(), "临时目录应被删掉");

    // 取消:再新建一个,abort 之后分片记录清空
    let session = harness
        .uploads
        .create(NewUpload {
            name: "cancel.md".to_owned(),
            rel_path: None,
            size: 16,
            sha256: None,
            collection: COLLECTION.to_owned(),
            tags: Vec::new(),
            batch: None,
            strategy: None,
        })
        .await
        .expect("新建上传");
    harness
        .uploads
        .put_part(&session.upload_id, 0, vec![1u8; 16], None)
        .await
        .expect("写分片");
    let aborted = harness
        .uploads
        .abort(&session.upload_id)
        .await
        .expect("取消上传");
    assert_eq!(aborted.state, kb_core::model::UploadState::Aborted);
    // 续传信息里要能看到状态,否则客户端无法区分“还在传 / 已完成 / 已取消”
    let status = harness
        .uploads
        .status(&session.upload_id)
        .await
        .expect("取消后的状态");
    assert_eq!(status.state, "aborted");
    assert!(
        kb_core::ports::repo::UploadRepo::parts(harness.env.meta.as_ref(), &session.upload_id)
            .await
            .expect("查分片")
            .is_empty()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn docx_upload_becomes_searchable_chunks() {
    // :Office 文档走“抽取 → DocChunker → 索引”,块里是正文而不是二进制
    let harness = Harness::new().await;
    let document = r#"<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>季度报告</w:t></w:r></w:p>
<w:p><w:r><w:t>本季度新增了两个数据源。</w:t></w:r></w:p>
</w:body></w:document>"#;
    let path = harness.env.home().join("report.docx");
    kb_testkit::zip::write_zip(
        &path,
        &[
            (
                "[Content_Types].xml",
                kb_testkit::zip::Entry::stored(b"<Types/>"),
            ),
            (
                "word/document.xml",
                kb_testkit::zip::Entry::stored(document.as_bytes()),
            ),
        ],
    );
    let bytes = std::fs::read(&path).expect("读 docx");
    let completed = harness
        .upload("report.docx", Some("docs/report.docx"), &bytes, None)
        .await;
    harness.run_ingest(&completed.batch_id).await;

    let files = harness.batch_files(&completed.batch_id).await;
    let file = files
        .iter()
        .find(|file| file.rel_path == "docs/report.docx")
        .expect("docx 应在队列里");
    assert_eq!(file.state, IngestState::Done, "{file:?}");
    assert!(file.chunks > 0, "抽取后应有块:{file:?}");
    // 解析队列的「内容」列:docx 没有页/表概念,extract_meta 是空对象(不是 None,说明写过了)
    let meta = file.extract_meta.as_deref().expect("应写入 extract_meta");
    assert!(meta.contains('{'), "{meta}");
    let chunks = ChunkRepo::by_path(harness.env.meta.as_ref(), COLLECTION, "docs/report.docx")
        .await
        .expect("查块");
    assert!(!chunks.is_empty());
    let (rows, _) = harness.chunks_of("docs/report.docx").await;
    assert_eq!(rows, chunks.len() as u64, "SQLite 与 LanceDB 的块数应一致");
    // 块的正文里应出现文档内容
    let collection =
        kb_core::ports::repo::CollectionRepo::get(harness.env.meta.as_ref(), COLLECTION)
            .await
            .expect("取 collection")
            .expect("collection 存在");
    let ids: Vec<String> = chunks.iter().map(|chunk| chunk.id.clone()).collect();
    let records = harness
        .env
        .store
        .get(&collection.active_table, &ids)
        .await
        .expect("读向量行");
    let text: String = records
        .iter()
        .map(|row| row.text.clone())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(text.contains("季度报告"), "{text}");
    assert!(text.contains("新增了两个数据源"), "{text}");

    // 当前阶段:anchor 一路带到检索结果(检索命中后能定位回原文)
    let search = kb_service::SearchService::new(
        harness.env.meta.clone(),
        harness.env.store.clone(),
        harness.env.embedder.clone(),
        std::sync::Arc::new(kb_service::search::NoopReranker),
        kb_service::SearchOptions::default(),
    );
    let response = search
        .search(kb_service::SearchRequest {
            query: "季度报告".to_owned(),
            collections: vec![COLLECTION.to_owned()],
            k: Some(5),
            explain: false,
            rerank: None,
        })
        .await
        .expect("检索");
    let hit = response
        .hits
        .iter()
        .find(|hit| hit.source == "docs/report.docx")
        .expect("应命中 docx");
    assert!(hit.anchor.is_some(), "检索命中应带 anchor(位置):{hit:?}");
}

/// 一封带两个附件(`notes.txt` / `readme.md`)的最小邮件(用例共用)。
const TWO_ATTACHMENT_EML: &str = "From: a@example.com\r\n\
     Subject: 周报\r\n\
     Content-Type: multipart/mixed; boundary=\"B\"\r\n\
     \r\n\
     --B\r\n\
     Content-Type: text/plain; charset=utf-8\r\n\
     \r\n\
     本周完成了上传链路。\r\n\
     --B\r\n\
     Content-Type: text/plain; name=\"notes.txt\"\r\n\
     Content-Disposition: attachment; filename=\"notes.txt\"\r\n\
     \r\n\
     附件一的正文。\r\n\
     --B\r\n\
     Content-Type: text/markdown; name=\"readme.md\"\r\n\
     Content-Disposition: attachment; filename=\"readme.md\"\r\n\
     \r\n\
     # 附件二\r\n\r\n第二份内容。\r\n\
     --B--\r\n";

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn eml_with_two_attachments_produces_three_items_and_edges() {
    // :邮件正文 + 2 个附件 = 3 个条目,附件用 derived_from 关联回邮件
    let harness = Harness::new().await;
    let completed = harness
        .upload(
            "mail.eml",
            Some("mail.eml"),
            TWO_ATTACHMENT_EML.as_bytes(),
            None,
        )
        .await;
    harness.run_ingest(&completed.batch_id).await;

    let files = harness.batch_files(&completed.batch_id).await;
    let mut paths: Vec<&str> = files.iter().map(|file| file.rel_path.as_str()).collect();
    paths.sort_unstable();
    assert_eq!(
        paths,
        vec!["mail.eml", "mail/notes.txt", "mail/readme.md"],
        "邮件正文 + 两个附件应各成一个条目:{files:?}"
    );
    for file in &files {
        assert_eq!(file.state, IngestState::Done, "{file:?}");
    }

    // 两个附件都有 derived_from 边指向邮件
    let edges = kb_core::ports::repo::EdgeRepo::by_dst(harness.env.meta.as_ref(), "path:mail.eml")
        .await
        .expect("查边");
    assert_eq!(
        edges.len(),
        2,
        "两个附件应各有一条 derived_from 边:{edges:?}"
    );
    assert!(
        edges
            .iter()
            .all(|edge| edge.rel == kb_core::model::EdgeRel::DerivedFrom)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn zip_with_html_and_pdf_is_unpacked_extracted_and_searchable() {
    // 专门验收:压缩包里的 HTML / PDF 递归抽取(解包 → 各自抽取器 → DocChunker → 索引)。
    // 断言三件事:路径带压缩包目录、块里是正文(导航被剪掉 / PDF 带页锚点)、子条目有派生边。
    let harness = Harness::new().await;
    let dir = harness.env.home().join("bundle");
    std::fs::create_dir_all(&dir).expect("建目录");
    let zip_path = dir.join("bundle.zip");
    let html = "<html><head><title>安装指南</title></head><body>\
                <nav>首页 | 文档 | 关于</nav>\
                <header>站点页眉</header>\
                <main><h1>安装指南</h1><p>先启动守护进程,再导入目录。</p></main>\
                <footer>版权所有</footer>\
                </body></html>";
    let pdf = kb_testkit::pdf::minimal("Hybrid retrieval combines vector and keyword");
    kb_testkit::zip::write_zip(
        &zip_path,
        &[
            (
                "docs/guide.html",
                kb_testkit::zip::Entry::stored(html.as_bytes()),
            ),
            ("docs/manual.pdf", kb_testkit::zip::Entry::stored(&pdf)),
        ],
    );
    let bytes = std::fs::read(&zip_path).expect("读 zip");
    let completed = harness
        .upload("bundle.zip", Some("bundle.zip"), &bytes, None)
        .await;
    let errors = harness.run_ingest(&completed.batch_id).await;
    assert!(errors.is_empty(), "解包与抽取不该有失败:{errors:?}");

    // 1) 路径:解出来的文件在 `bundle/` 下,保留包内目录结构
    let files = harness.batch_files(&completed.batch_id).await;
    let mut paths: Vec<&str> = files.iter().map(|file| file.rel_path.as_str()).collect();
    paths.sort_unstable();
    assert_eq!(
        paths,
        vec![
            "bundle.zip",
            "bundle/docs/guide.html",
            "bundle/docs/manual.pdf"
        ],
        "解包路径应是 <压缩包名>/<包内路径>:{files:?}"
    );
    for file in files.iter().filter(|file| file.rel_path != "bundle.zip") {
        assert_eq!(file.state, IngestState::Done, "{file:?}");
        assert!(file.chunks > 0, "抽取后应有块:{file:?}");
        assert_eq!(
            file.derived_from.as_deref(),
            Some("bundle.zip"),
            "子条目应记住父压缩包:{file:?}"
        );
    }

    // 2) 块:HTML 走抽取器(导航 / 页眉页脚被剪掉),PDF 按页成块并带页锚点
    let html_text = harness.chunk_text("bundle/docs/guide.html").await;
    assert!(html_text.contains("先启动守护进程"), "{html_text}");
    assert!(
        !html_text.contains("站点页眉") && !html_text.contains("版权所有"),
        "导航 / 页眉页脚不该进块:{html_text}"
    );
    let pdf_text = harness.chunk_text("bundle/docs/manual.pdf").await;
    assert!(pdf_text.contains("Hybrid retrieval"), "{pdf_text}");
    // anchor 落在 LanceDB 行上(检索命中后据此定位回原文第几页)
    let anchors = harness.chunk_anchors("bundle/docs/manual.pdf").await;
    assert!(!anchors.is_empty(), "PDF 应有块");
    assert!(
        anchors
            .iter()
            .all(|anchor| matches!(anchor, Some(Anchor::Page { page: 1 }))),
        "PDF 块应带页锚点:{anchors:?}"
    );

    // 3) 可检索:两种格式都能按正文命中
    let search = kb_service::SearchService::new(
        harness.env.meta.clone(),
        harness.env.store.clone(),
        harness.env.embedder.clone(),
        std::sync::Arc::new(kb_service::search::NoopReranker),
        kb_service::SearchOptions::default(),
    );
    for (query, expected) in [
        ("先启动守护进程", "bundle/docs/guide.html"),
        ("Hybrid retrieval", "bundle/docs/manual.pdf"),
    ] {
        let response = search
            .search(kb_service::SearchRequest {
                query: query.to_owned(),
                collections: vec![COLLECTION.to_owned()],
                k: Some(10),
                explain: false,
                rerank: None,
            })
            .await
            .expect("检索");
        assert!(
            response.hits.iter().any(|hit| hit.source == expected),
            "检索 “{query}” 应命中 {expected}:{:?}",
            response
                .hits
                .iter()
                .map(|hit| &hit.source)
                .collect::<Vec<_>>()
        );
    }

    // 4) 边:两个子条目各有一条 derived_from 边指向压缩包,来源块属于各自的子条目
    let edges = EdgeRepo::by_dst(harness.env.meta.as_ref(), "path:bundle.zip")
        .await
        .expect("查边");
    assert_eq!(edges.len(), 2, "两个子条目应各有一条边:{edges:?}");
    assert!(
        edges.iter().all(|edge| edge.rel == EdgeRel::DerivedFrom),
        "{edges:?}"
    );
    let mut child_chunk_ids: Vec<String> = Vec::new();
    for path in ["bundle/docs/guide.html", "bundle/docs/manual.pdf"] {
        let chunks = ChunkRepo::by_path(harness.env.meta.as_ref(), COLLECTION, path)
            .await
            .expect("查块");
        child_chunk_ids.extend(chunks.into_iter().map(|chunk| chunk.id));
    }
    for edge in &edges {
        assert!(
            child_chunk_ids.contains(&edge.src_id),
            "边的起点应是子条目的块:{edge:?}"
        );
    }

    // 5) 撤销批次:块与边一起清掉,不留指向已删块的悬挂边
    harness
        .revert
        .revert(&completed.batch_id)
        .await
        .expect("撤销批次");
    let edges = EdgeRepo::by_dst(harness.env.meta.as_ref(), "path:bundle.zip")
        .await
        .expect("查边");
    assert!(edges.is_empty(), "撤销后不该留下悬挂的派生边:{edges:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn eml_derived_edges_are_restored_after_a_restart() {
    // :父子关系落在 `ingest_files.derived_from` 上,进程重启后重新处理附件仍能补边。
    // 以前这条关系只在解析任务的进程内表里,重启后中途批次的派生边就补不回来了。
    let harness = Harness::new().await;
    let completed = harness
        .upload(
            "mail.eml",
            Some("mail.eml"),
            TWO_ATTACHMENT_EML.as_bytes(),
            None,
        )
        .await;

    // 第一个“进程”只处理邮件本身(一片一个文件),附件还在队列里就被杀掉
    let crashed = harness.handler(1);
    let (finished, errors) = harness.run_slice_once(&crashed, &completed.batch_id).await;
    assert!(errors.is_empty(), "{errors:?}");
    assert!(!finished, "附件还没处理,批次不该结束");
    let files = harness.batch_files(&completed.batch_id).await;
    let mut queued: Vec<&str> = files
        .iter()
        .filter(|file| file.state == IngestState::Queued)
        .map(|file| file.rel_path.as_str())
        .collect();
    queued.sort_unstable();
    assert_eq!(
        queued,
        vec!["mail/notes.txt", "mail/readme.md"],
        "{files:?}"
    );
    assert!(
        EdgeRepo::by_dst(harness.env.meta.as_ref(), "path:mail.eml")
            .await
            .expect("查边")
            .is_empty(),
        "附件还没入库,这时不该有边"
    );

    // 重启:新的处理器接着把附件处理完 → 两条派生边补上
    let restarted = harness.handler(10);
    let errors = harness
        .run_ingest_with(&restarted, &completed.batch_id)
        .await;
    assert!(errors.is_empty(), "{errors:?}");
    let edges = EdgeRepo::by_dst(harness.env.meta.as_ref(), "path:mail.eml")
        .await
        .expect("查边");
    assert_eq!(
        edges.len(),
        2,
        "重启后附件索引完成应各补一条 derived_from 边:{edges:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn missing_derived_edges_are_repaired_when_the_batch_finishes() {
    // 批次收尾的崩溃窗口:子条目已经写完状态、边还没来得及写。
    // 重启后任务把批次跑完时已经没有 queued 文件,靠收尾时的补齐逻辑按行把边补回来。
    let harness = Harness::new().await;
    let completed = harness
        .upload(
            "mail.eml",
            Some("mail.eml"),
            TWO_ATTACHMENT_EML.as_bytes(),
            None,
        )
        .await;
    harness.run_ingest(&completed.batch_id).await;
    let edges = EdgeRepo::by_dst(harness.env.meta.as_ref(), "path:mail.eml")
        .await
        .expect("查边");
    assert_eq!(edges.len(), 2, "{edges:?}");

    // 抹掉两条边,并把批次退回“运行中”:等价于“边没写就崩了,任务下次启动还要收尾”
    for edge in &edges {
        EdgeRepo::remove(harness.env.meta.as_ref(), &edge.src_id, &edge.dst, edge.rel)
            .await
            .expect("删边");
    }
    IngestProgressRepo::set_ingest_batch_state(
        harness.env.meta.as_ref(),
        &completed.batch_id,
        IngestBatchState::Running,
        1,
    )
    .await
    .expect("退回运行中");

    let restarted = harness.handler(10);
    let errors = harness
        .run_ingest_with(&restarted, &completed.batch_id)
        .await;
    assert!(errors.is_empty(), "{errors:?}");
    let edges = EdgeRepo::by_dst(harness.env.meta.as_ref(), "path:mail.eml")
        .await
        .expect("查边");
    assert_eq!(edges.len(), 2, "收尾时应把缺失的边补齐:{edges:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn image_without_ocr_is_ingested_as_skipped() {
    // :图片在 OCR 关闭时也要入库(标 skipped + 说明),不能被判失败或隔离
    let harness = Harness::new().await;
    let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    png.extend_from_slice(&[0u8; 32]);
    let completed = harness
        .upload("photo.png", Some("photo.png"), &png, None)
        .await;
    harness.run_ingest(&completed.batch_id).await;

    let files = harness.batch_files(&completed.batch_id).await;
    let file = files
        .iter()
        .find(|file| file.rel_path == "photo.png")
        .expect("图片应在队列里");
    assert_eq!(
        file.state,
        IngestState::Done,
        "关闭 OCR 时图片也要入库(不能 failed / quarantined):{file:?}"
    );
    assert!(file.chunks >= 1, "至少有一块“需要 OCR”的说明块:{file:?}");
    // 说明块里带 needs_ocr 标记,检索“needs_ocr”能找到这张图
    let chunks = ChunkRepo::by_path(harness.env.meta.as_ref(), COLLECTION, "photo.png")
        .await
        .expect("查块");
    assert!(!chunks.is_empty());
    let (rows, _) = harness.chunks_of("photo.png").await;
    assert_eq!(rows, chunks.len() as u64);
    let collection =
        kb_core::ports::repo::CollectionRepo::get(harness.env.meta.as_ref(), COLLECTION)
            .await
            .expect("取 collection")
            .expect("collection 存在");
    let ids: Vec<String> = chunks.iter().map(|chunk| chunk.id.clone()).collect();
    let records = harness
        .env
        .store
        .get(&collection.active_table, &ids)
        .await
        .expect("读向量行");
    let text: String = records
        .iter()
        .map(|row| row.text.clone())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(text.contains("needs_ocr"), "块里应有 needs_ocr 标记:{text}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn notion_export_zip_is_unpacked_and_indexed() {
    // :Notion / Confluence 导出包就是 zip(md + csv / html),走既有解包 + 抽取。
    // 断言按“数据源下的全部文件”来做:解包出来的子行与压缩包本身可能落在不同批次,
    // 但一定属于同一个数据源(批次归属的差异见复查记录)。
    let harness = Harness::new().await;
    let dir = harness.env.home().join("export");
    std::fs::create_dir_all(&dir).expect("建目录");
    let zip_path = dir.join("export.zip");
    kb_testkit::zip::write_zip(
        &zip_path,
        &[
            (
                "页面/项目周报.md",
                kb_testkit::zip::Entry::stored("# 项目周报\n\n本周完成了网页抓取。\n".as_bytes()),
            ),
            (
                "页面/预算.csv",
                kb_testkit::zip::Entry::stored("名称,数量\n研发,3\n".as_bytes()),
            ),
            (
                "页面/导出.html",
                kb_testkit::zip::Entry::stored(
                    "<html><body><h1>导出页</h1><p>这是 Confluence 风格的导出。</p></body></html>"
                        .as_bytes(),
                ),
            ),
        ],
    );
    let bytes = std::fs::read(&zip_path).expect("读 zip");
    let completed = harness
        .upload("export.zip", Some("export.zip"), &bytes, None)
        .await;
    harness.run_ingest(&completed.batch_id).await;

    // 解包出来的文件在同一数据源下,按 source_id 列出来
    let parent = IngestRepo::get_by_path(harness.env.meta.as_ref(), COLLECTION, "export.zip")
        .await
        .expect("查压缩包")
        .expect("压缩包行应存在");
    let files = IngestRepo::list(
        harness.env.meta.as_ref(),
        IngestFilter {
            collection: None,
            batch_id: None,
            source_id: parent.source_id.clone(),
            state: None,
        },
        Page::new(100, 0),
    )
    .await
    .expect("列数据源下的文件");
    let mut paths: Vec<String> = files
        .iter()
        .filter(|file| file.state == IngestState::Done && file.chunks > 0)
        .map(|file| file.rel_path.clone())
        .collect();
    paths.sort();
    assert!(
        paths.iter().any(|path| path.ends_with("项目周报.md")),
        "Markdown 应被解出来并索引:{files:?}"
    );
    assert!(
        paths.iter().any(|path| path.ends_with("预算.csv")),
        "CSV 应被解出来并索引:{files:?}"
    );
    assert!(
        paths.iter().any(|path| path.ends_with("导出.html")),
        "HTML 应被解出来并索引:{files:?}"
    );
}

/// 真实验收用的 200 MB 断网续传(`cargo test -p kb-service --test upload -- --ignored`)。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "200 MB 的真实续传用例,手工跑:--ignored resumes_a_200mb_upload"]
async fn resumes_a_200mb_upload() {
    let harness = Harness::new().await;
    // 200 MB 的伪随机内容(不要全 0,免得被压缩类逻辑影响)
    let mut content = Vec::with_capacity(200 * 1024 * 1024);
    let mut state = 0x1234_5678u64;
    while content.len() < 200 * 1024 * 1024 {
        state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
        content.extend_from_slice(&state.to_le_bytes());
    }
    let sha = kb_core::hash::sha256_hex_bytes(&content);
    let session = harness
        .uploads
        .create(NewUpload {
            name: "huge.bin".to_owned(),
            rel_path: Some("huge.bin".to_owned()),
            size: content.len() as u64,
            sha256: Some(sha.clone()),
            collection: COLLECTION.to_owned(),
            tags: Vec::new(),
            batch: None,
            strategy: None,
        })
        .await
        .expect("新建上传");
    assert_eq!(session.parts_total, 200, "200 MB / 1 MB");

    // 传一半后“断网”
    let parts: Vec<&[u8]> = content.chunks(session.chunk_size as usize).collect();
    for (index, part) in parts.iter().take(100).enumerate() {
        harness
            .uploads
            .put_part(&session.upload_id, index as u32, part.to_vec(), None)
            .await
            .expect("写分片");
    }
    let status = harness
        .uploads
        .status(&session.upload_id)
        .await
        .expect("状态");
    assert_eq!(status.received.len(), 100);

    // 重连:只补传剩下的 100 片
    let missing = harness
        .uploads
        .missing_parts(&session.upload_id)
        .await
        .expect("缺片");
    assert_eq!(missing.len(), 100);
    for index in missing {
        harness
            .uploads
            .put_part(
                &session.upload_id,
                index,
                parts[index as usize].to_vec(),
                None,
            )
            .await
            .expect("补传分片");
    }
    let completed = harness
        .uploads
        .complete("test", &session.upload_id)
        .await
        .expect("完成上传");
    assert_eq!(completed.files[0].sha256.as_deref(), Some(sha.as_str()));
    let stored = harness.source_file("huge.bin");
    assert_eq!(
        kb_core::hash::sha256_hex_file(&stored).expect("算哈希"),
        sha,
        "200 MB 合并后的 sha256 必须一致"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn odt_upload_is_extracted_instead_of_unpacked() {
    // 收口:ODT 也是 zip 容器,但必须走 `OdtExtractor` 抽正文,
    // 不能被“是不是压缩包”的判断拆成 mimetype / content.xml 等子条目
    let harness = Harness::new().await;
    let content = r#"<?xml version="1.0"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:h text:outline-level="1">项目周报</text:h><text:p>本周补齐了 ODT 抽取的端到端链路。</text:p></office:text></office:body></office:document-content>"#;
    let path = harness.env.home().join("weekly.odt");
    kb_testkit::zip::write_zip(
        &path,
        &[
            (
                "mimetype",
                kb_testkit::zip::Entry::stored(b"application/vnd.oasis.opendocument.text"),
            ),
            (
                "content.xml",
                kb_testkit::zip::Entry::stored(content.as_bytes()),
            ),
        ],
    );
    let bytes = std::fs::read(&path).expect("读 odt");
    let completed = harness
        .upload("weekly.odt", Some("docs/weekly.odt"), &bytes, None)
        .await;
    harness.run_ingest(&completed.batch_id).await;

    let files = harness.batch_files(&completed.batch_id).await;
    let paths: Vec<&str> = files.iter().map(|file| file.rel_path.as_str()).collect();
    assert_eq!(
        paths,
        vec!["docs/weekly.odt"],
        "ODT 应当作一个文档入库,不该解包出子条目"
    );
    let file = &files[0];
    assert_eq!(file.state, IngestState::Done, "{file:?}");
    assert!(file.chunks > 0, "抽取后应有块:{file:?}");
    // 块里应是正文(标题 + 段落),不是 XML 源码
    let text = harness.chunk_text("docs/weekly.odt").await;
    assert!(text.contains("项目周报"), "{text}");
    assert!(text.contains("本周补齐了 ODT 抽取"), "{text}");
    assert!(
        !text.contains("<office:"),
        "块里应是正文而不是 XML 源码:{text}"
    );
}

// ---------------------------------------------------------------- 旧格式 Office 入库转换

/// 旧格式文件的头(OLE 复合文档魔数):不是文本、也不是 zip,注册表里没有抽取器。
fn legacy_ole_bytes() -> Vec<u8> {
    let mut bytes = vec![0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
    bytes.extend_from_slice(&[0u8; 64]);
    bytes
}

/// 造一个能被 docx 抽取器读出正文的最小 docx。
fn small_docx(path: &std::path::Path) {
    let document = r#"<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>季度报告</w:t></w:r></w:p>
<w:p><w:r><w:t>本季度新增了两个数据源。</w:t></w:r></w:p>
</w:body></w:document>"#;
    kb_testkit::zip::write_zip(
        path,
        &[
            (
                "[Content_Types].xml",
                kb_testkit::zip::Entry::stored(b"<Types/>"),
            ),
            (
                "word/document.xml",
                kb_testkit::zip::Entry::stored(document.as_bytes()),
            ),
        ],
    );
}

/// 写一个假的 soffice:解析出 `--outdir` 和输入文件名,再执行 `body`(里面可用 `$out` `$stem`)。
fn fake_soffice(dir: &std::path::Path, body: &str) -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let path = dir.join("fake-soffice");
    let script = format!(
        "#!/bin/sh\nout=''; prev=''; last=''\nfor a in \"$@\"; do\n  if [ \"$prev\" = '--outdir' ]; then out=\"$a\"; fi\n  prev=\"$a\"; last=\"$a\"\ndone\nstem=$(basename \"$last\"); stem=\"${{stem%.*}}\"\n{body}\n"
    );
    std::fs::write(&path, script).expect("写假 soffice");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("加执行权限");
    path
}

/// 挂了假转换器的处理器。
fn converting_handler(harness: &Harness, body: &str) -> IngestJobHandler {
    let dir = harness.env.home().join("fake-lo");
    std::fs::create_dir_all(&dir).expect("建目录");
    let converter = kb_service::office_convert::Converter::new(
        fake_soffice(&dir, body),
        dir.join("work"),
        std::time::Duration::from_secs(20),
        1,
    );
    harness.handler(10).with_converter(converter)
}

async fn ingested_text(harness: &Harness, rel_path: &str) -> String {
    let collection = CollectionRepo::get(harness.env.meta.as_ref(), COLLECTION)
        .await
        .expect("取 collection")
        .expect("collection 存在");
    let chunks = ChunkRepo::by_path(harness.env.meta.as_ref(), COLLECTION, rel_path)
        .await
        .expect("查块");
    let ids: Vec<String> = chunks.iter().map(|chunk| chunk.id.clone()).collect();
    harness
        .env
        .store
        .get(&collection.active_table, &ids)
        .await
        .expect("读向量行")
        .iter()
        .map(|row| row.text.clone())
        .collect::<Vec<_>>()
        .join("\n")
}

/// 没有转换器时,旧格式文件记 `skipped` 并**保留原件**(用户还能打开、下载)。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn legacy_doc_without_a_converter_is_skipped_and_kept() {
    let harness = Harness::new().await;
    let completed = harness
        .upload("old.doc", Some("docs/old.doc"), &legacy_ole_bytes(), None)
        .await;
    harness.run_ingest(&completed.batch_id).await;
    let files = harness.batch_files(&completed.batch_id).await;
    let file = files
        .iter()
        .find(|file| file.rel_path == "docs/old.doc")
        .expect("应在队列里");
    assert_eq!(file.state, IngestState::Skipped, "{file:?}");
    assert!(
        std::path::Path::new(&file.abs_path).exists(),
        "原件不能被挪走:{}",
        file.abs_path
    );
}

/// 挂了转换器:旧 .doc 转成 docx 后抽取、入库、可检索;**原件不动**(路径、字节都不变)。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn legacy_doc_is_converted_for_indexing_and_the_original_is_untouched() {
    let harness = Harness::new().await;
    let fixture = harness.env.home().join("converted.docx");
    small_docx(&fixture);
    let handler = converting_handler(
        &harness,
        &format!("cp {} \"$out/$stem.docx\"", fixture.display()),
    );
    let original = legacy_ole_bytes();
    let completed = harness
        .upload("old.doc", Some("docs/old.doc"), &original, None)
        .await;
    let errors = harness.run_ingest_with(&handler, &completed.batch_id).await;
    assert!(errors.is_empty(), "{errors:?}");

    let files = harness.batch_files(&completed.batch_id).await;
    let file = files
        .iter()
        .find(|file| file.rel_path == "docs/old.doc")
        .expect("路径仍是原来的 .doc,没有改名");
    assert_eq!(file.state, IngestState::Done, "{file:?}");
    assert!(file.chunks > 0, "{file:?}");
    let text = ingested_text(&harness, "docs/old.doc").await;
    assert!(text.contains("季度报告"), "{text}");
    assert!(text.contains("新增了两个数据源"), "{text}");
    assert_eq!(
        std::fs::read(&file.abs_path).expect("原件还在"),
        original,
        "原件的字节不能被改动"
    );
    // 索引里记的是原件的哈希和大小,不是转换产物的(产物里有时间戳,每次转换不一定相同,
    // 记产物的哈希会让同一份原件每次都像「变了」)
    let record = FileRepo::get(harness.env.meta.as_ref(), COLLECTION, "docs/old.doc")
        .await
        .expect("查文件记录")
        .expect("应有文件记录");
    assert_eq!(
        record.file_hash,
        kb_service::index::pipeline::file_hash(&original)
    );
    assert_eq!(record.size, original.len() as u64);
}

/// 转换器加载失败(退出码 0、没有产出):记 `failed`,写明转换失败,**原件留着**。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_failed_conversion_fails_with_a_reason() {
    let harness = Harness::new().await;
    let handler = converting_handler(
        &harness,
        "echo 'Error: source file could not be loaded' >&2\nexit 0",
    );
    let completed = harness
        .upload("bad.doc", Some("docs/bad.doc"), &legacy_ole_bytes(), None)
        .await;
    harness.run_ingest_with(&handler, &completed.batch_id).await;
    let files = harness.batch_files(&completed.batch_id).await;
    let file = files
        .iter()
        .find(|file| file.rel_path == "docs/bad.doc")
        .expect("应在队列里");
    assert_eq!(file.state, IngestState::Failed, "{file:?}");
    let reason = file.error.clone().unwrap_or_default();
    assert!(reason.contains("转换"), "原因里应写明转换失败:{reason}");
    assert!(
        std::path::Path::new(&file.abs_path).exists(),
        "原件不能被挪走:{}",
        file.abs_path
    );
}

/// 没有真实样本验证过的格式(ppt 等)不调用转换器,记 `skipped` 并保留原件。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unverified_legacy_formats_do_not_start_the_converter() {
    let harness = Harness::new().await;
    let marker = harness.env.home().join("converter-ran");
    let handler = converting_handler(&harness, &format!("touch {}", marker.display()));
    let completed = harness
        .upload("deck.ppt", Some("docs/deck.ppt"), &legacy_ole_bytes(), None)
        .await;
    harness.run_ingest_with(&handler, &completed.batch_id).await;
    let files = harness.batch_files(&completed.batch_id).await;
    let file = files
        .iter()
        .find(|file| file.rel_path == "docs/deck.ppt")
        .expect("应在队列里");
    assert_eq!(file.state, IngestState::Skipped, "{file:?}");
    assert!(!marker.exists(), "ppt 没有验证过,不该启动转换器");
    assert!(
        std::path::Path::new(&file.abs_path).exists(),
        "原件不能被挪走:{}",
        file.abs_path
    );
}

/// 真实 LibreOffice 的端到端:上传仓库自带的 `sample.doc`,走完整的入库流程,可检索、原件不变。
/// 默认不跑:`KB_SOFFICE_DIR=<安装目录> KB_SOFFICE_LD=<LD_LIBRARY_PATH> cargo test -p kb-service
/// --test upload -- --ignored real_libreoffice`。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "需要本机装好 LibreOffice:设置 KB_SOFFICE_DIR(和 KB_SOFFICE_LD)"]
async fn real_libreoffice_makes_a_legacy_doc_searchable() {
    let Ok(install) = std::env::var("KB_SOFFICE_DIR") else {
        return;
    };
    let harness = Harness::new().await;
    let soffice = kb_service::office_convert::Converter::locate(std::path::Path::new(&install))
        .expect("安装目录里应有 program/soffice");
    let mut converter = kb_service::office_convert::Converter::new(
        soffice,
        harness.env.home().join("lo-work"),
        std::time::Duration::from_secs(120),
        1,
    );
    if let Ok(ld) = std::env::var("KB_SOFFICE_LD") {
        converter = converter.with_env("LD_LIBRARY_PATH", &ld);
    }
    let handler = harness.handler(10).with_converter(converter);
    let original = std::fs::read(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../web-ui/e2e/fixtures/sample.doc"),
    )
    .expect("读夹具");
    let completed = harness
        .upload("sample.doc", Some("docs/sample.doc"), &original, None)
        .await;
    let errors = harness.run_ingest_with(&handler, &completed.batch_id).await;
    assert!(errors.is_empty(), "{errors:?}");
    let files = harness.batch_files(&completed.batch_id).await;
    let file = files
        .iter()
        .find(|file| file.rel_path == "docs/sample.doc")
        .expect("应在队列里");
    assert_eq!(file.state, IngestState::Done, "{file:?}");
    let text = ingested_text(&harness, "docs/sample.doc").await;
    println!(
        "indexed text: {}",
        text.chars().take(60).collect::<String>()
    );
    assert!(text.contains("向量检索"), "{text}");
    assert_eq!(std::fs::read(&file.abs_path).expect("原件还在"), original);
}

/// 新上传的解析任务要排在积压前面:否则几百份文件的批次一跑几小时,用户传完搜不到。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_fresh_upload_jumps_ahead_of_the_backlog() {
    let harness = Harness::new().await;
    let completed = harness
        .upload(
            "fresh.md",
            Some("rec/fresh.md"),
            "# 新上传\n\n正文。\n".as_bytes(),
            None,
        )
        .await;
    // 上传结束后队列里那条任务就是用户“传完立刻要能搜到”的那条
    let queue = JobQueue::new(harness.env.meta.clone());
    let job = queue
        .list(Some(JobState::Queued))
        .await
        .expect("列排队任务")
        .into_iter()
        .find(|job| job.kind == "ingest" && job.payload_json.contains(&completed.batch_id))
        .expect("上传要投一条解析任务");
    assert_eq!(
        job.priority,
        kb_service::jobs::queue::priority::INGEST_UPLOAD,
        "上传投递要用新上传的优先级:{job:?}"
    );
    // 老化天花板是 89(kb-meta 的 repo/job.rs):不高于它就会排在积压后面
    assert!(
        job.priority > 89,
        "要高于老化天花板 89,否则新上传仍然排在积压后面:{}",
        job.priority
    );
}
