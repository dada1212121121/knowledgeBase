//! 验收:删除进回收站 / 恢复 / 移动 / 文件夹按路径段边界。
//!
//! 这里用真实的 SQLite + LanceDB + Fake embedder,断言的是用户看到的结果:
//! 原文件去哪了、索引里还有没有、移动后块 id 是否按新路径重建。

use std::sync::Arc;

use kb_core::model::{FileOpState, IngestFile, IngestState, Source, SourceKind, SourceStatus};
use kb_core::ports::repo::{
    AnnotationRepo, ChunkRepo, CollectionRepo, FileOpsRepo, FileRepo, IngestRepo, SourceRepo,
    VersionRepo,
};
use kb_service::index::IndexOptions;
use kb_service::{FileOpsService, IndexService};
use kb_testkit::TestEnv;

const COLLECTION: &str = "_global";

struct Harness {
    env: TestEnv,
    service: FileOpsService,
    source_id: String,
    root: std::path::PathBuf,
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
        let source_id = uuid::Uuid::now_v7().to_string();
        let root = env.paths().source_dir(&source_id);
        std::fs::create_dir_all(&root).expect("建数据源目录");
        SourceRepo::create(
            env.meta.as_ref(),
            Source {
                id: source_id.clone(),
                kind: SourceKind::Upload,
                name: format!("file-ops-{source_id}"),
                uri: root.to_string_lossy().into_owned(),
                collection: COLLECTION.to_owned(),
                tags: vec!["测试".to_owned()],
                include: Vec::new(),
                exclude: Vec::new(),
                depth: 1,
                allow_hosts: Vec::new(),
                refresh_minutes: None,
                status: SourceStatus::Idle,
                last_synced_at: None,
                last_error: None,
                files: 0,
                created_at: 1,
                ai_extract: false,
                extract_prompt: String::new(),
                ai_status: None,
            },
        )
        .await
        .expect("建数据源");
        let index = Arc::new(IndexService::new(
            env.meta.clone(),
            env.store.clone(),
            env.embedder.clone(),
            env.chunker.clone(),
            env.scanner.clone(),
            IndexOptions::default(),
        ));
        let service = FileOpsService::new(env.meta.clone(), env.store.clone(), index, env.paths());
        Self {
            env,
            service,
            source_id,
            root,
        }
    }

    async fn add(&self, rel_path: &str, content: &str) {
        let path = self.root.join(rel_path);
        std::fs::create_dir_all(path.parent().unwrap()).expect("建父目录");
        std::fs::write(&path, content).expect("写文件");
        let collection = CollectionRepo::get(self.env.meta.as_ref(), COLLECTION)
            .await
            .expect("取 collection")
            .expect("存在");
        let metadata = std::fs::metadata(&path).expect("元数据");
        IngestRepo::create(
            self.env.meta.as_ref(),
            IngestFile {
                id: uuid::Uuid::now_v7().to_string(),
                batch_id: None,
                source_id: Some(self.source_id.clone()),
                upload_id: None,
                collection: COLLECTION.to_owned(),
                rel_path: rel_path.to_owned(),
                abs_path: path.to_string_lossy().into_owned(),
                size: metadata.len(),
                sha256: None,
                state: IngestState::Done,
                error: None,
                chunks: 0,
                extract_meta: None,
                derived_from: None,
                vectors: 0,
                elapsed_ms: None,
                created_at: 1,
                updated_at: 1,
            },
        )
        .await
        .expect("建解析队列行");
        let entry = kb_core::model::ScanEntry {
            path: path.clone(),
            relative: rel_path.to_owned(),
            size: metadata.len(),
            mtime: kb_service::index::millis_of(&metadata),
            lang: kb_index::lang::detect_lang(&path).to_owned(),
            kind: kb_index::lang::kind_of(&path),
        };
        let spec = kb_service::index::FileIndexSpec {
            source: rel_path.to_owned(),
            kind: entry.kind,
            tags: Vec::new(),
        };
        let index = self
            .service_index()
            .index_entry_with("", &collection, &entry, &spec, 1)
            .await
            .expect("索引文件");
        assert!(index.chunks > 0);
    }

    fn service_index(&self) -> IndexService {
        // 测试里重新建一个和服务同一套依赖的索引器即可(无状态)。
        IndexService::new(
            self.env.meta.clone(),
            self.env.store.clone(),
            self.env.embedder.clone(),
            self.env.chunker.clone(),
            self.env.scanner.clone(),
            IndexOptions::default(),
        )
    }

    async fn indexed(&self, path: &str) -> bool {
        FileRepo::get(self.env.meta.as_ref(), COLLECTION, path)
            .await
            .expect("查 files")
            .is_some()
    }
}

#[tokio::test]
async fn deletes_managed_file_to_trash_and_restores_it() {
    let harness = Harness::new().await;
    harness.add("docs/a.md", "# A\n\n第一段内容。\n").await;

    let actions = harness
        .service
        .actions(COLLECTION, "docs/a.md")
        .await
        .expect("菜单");
    assert!(actions.delete.allowed);
    assert!(actions.r#move.allowed);
    assert_eq!(actions.origin, kb_core::model::FileOrigin::Upload);

    let op = harness
        .service
        .delete_file(COLLECTION, "docs/a.md", &actions.fingerprint.value)
        .await
        .expect("删除");
    assert_eq!(op.state, FileOpState::Done);
    assert!(!harness.root.join("docs/a.md").exists(), "原件应已搬走");
    assert!(!harness.indexed("docs/a.md").await, "索引应已移除");
    let trash = harness
        .service
        .list_trash(Some(COLLECTION), kb_core::model::Page::new(50, 0))
        .await
        .expect("列回收站");
    assert_eq!(trash.len(), 1);
    assert_eq!(trash[0].original_path, "docs/a.md");
    assert!(std::path::Path::new(trash[0].trash_path.as_deref().unwrap()).exists());

    // 删除后旧路径可以立刻复用(版本 / 批注已经挪到 trash: 隐藏键)
    harness.add("docs/a.md", "# A2\n\n新文件。\n").await;
    assert!(harness.indexed("docs/a.md").await);

    harness
        .service
        .restore(&trash[0].id)
        .await
        .expect_err("原路径被占用时应拒绝恢复");

    // 先把新文件删掉腾出路径,再恢复旧文件
    let again = harness
        .service
        .actions(COLLECTION, "docs/a.md")
        .await
        .expect("菜单");
    harness
        .service
        .delete_file(COLLECTION, "docs/a.md", &again.fingerprint.value)
        .await
        .expect("再删");
    harness.service.restore(&trash[0].id).await.expect("恢复");
    assert!(harness.root.join("docs/a.md").exists(), "应恢复回原路径");
    assert!(harness.indexed("docs/a.md").await, "恢复后应重新索引");
    assert_eq!(
        std::fs::read_to_string(harness.root.join("docs/a.md")).unwrap(),
        "# A\n\n第一段内容。\n"
    );
}

#[tokio::test]
async fn moves_file_and_rebuilds_chunk_ids_by_new_path() {
    let harness = Harness::new().await;
    harness.add("docs/a.md", "# A\n\n移动我。\n").await;
    let before = ChunkRepo::by_path(harness.env.meta.as_ref(), COLLECTION, "docs/a.md")
        .await
        .expect("旧块");
    assert!(!before.is_empty());

    let actions = harness
        .service
        .actions(COLLECTION, "docs/a.md")
        .await
        .expect("菜单");
    let op = harness
        .service
        .move_file(
            COLLECTION,
            "docs/a.md",
            COLLECTION,
            "archive/2026",
            Some("renamed.md"),
            &actions.fingerprint.value,
        )
        .await
        .expect("移动");
    assert_eq!(op.state, FileOpState::Done);
    assert!(!harness.root.join("docs/a.md").exists());
    assert!(harness.root.join("archive/2026/renamed.md").exists());
    assert!(!harness.indexed("docs/a.md").await);
    assert!(harness.indexed("archive/2026/renamed.md").await);
    let after = ChunkRepo::by_path(
        harness.env.meta.as_ref(),
        COLLECTION,
        "archive/2026/renamed.md",
    )
    .await
    .expect("新块");
    assert!(
        before
            .iter()
            .all(|old| after.iter().all(|new| new.id != old.id)),
        "块 id 必须按新路径重建"
    );
}

#[tokio::test]
async fn folder_delete_matches_segment_boundaries_not_prefix() {
    let harness = Harness::new().await;
    harness.add("docs/a.md", "# A\n").await;
    harness.add("docs/sub/b.md", "# B\n").await;
    harness.add("docs2/c.md", "# C\n").await;

    let actions = harness
        .service
        .actions(COLLECTION, "docs")
        .await
        .expect("菜单");
    assert!(actions.folder);
    assert_eq!(actions.files, 2, "docs 不能把 docs2 算进来");

    let op = harness
        .service
        .delete_folder(COLLECTION, "docs", &actions.fingerprint.value)
        .await
        .expect("删文件夹");
    assert_eq!(op.state, FileOpState::Done);
    assert!(!harness.indexed("docs/a.md").await);
    assert!(!harness.indexed("docs/sub/b.md").await);
    assert!(harness.indexed("docs2/c.md").await, "docs2 必须保留");
    assert!(harness.root.join("docs2/c.md").exists());
}

#[tokio::test]
async fn unindex_delete_keeps_local_file_and_records_exclusion() {
    let harness = Harness::new().await;
    // 本地目录数据源:文件在用户磁盘上,删除只能移除索引
    let local_id = uuid::Uuid::now_v7().to_string();
    let local_root = harness.env.paths().sources_dir().join("local-test");
    // 数据源根目录是 local-root,集合内相对路径是 local/note.md,物理路径必须对得上。
    std::fs::create_dir_all(local_root.join("local")).unwrap();
    let path = local_root.join("local/note.md");
    std::fs::write(&path, "# local\n").unwrap();
    SourceRepo::create(
        harness.env.meta.as_ref(),
        Source {
            id: local_id.clone(),
            kind: SourceKind::LocalDir,
            name: format!("local-{local_id}"),
            uri: local_root.to_string_lossy().into_owned(),
            collection: COLLECTION.to_owned(),
            tags: Vec::new(),
            include: Vec::new(),
            exclude: Vec::new(),
            depth: 1,
            allow_hosts: Vec::new(),
            refresh_minutes: None,
            status: SourceStatus::Idle,
            last_synced_at: None,
            last_error: None,
            files: 0,
            created_at: 1,
            ai_extract: false,
            extract_prompt: String::new(),
            ai_status: None,
        },
    )
    .await
    .unwrap();
    let collection = CollectionRepo::get(harness.env.meta.as_ref(), COLLECTION)
        .await
        .unwrap()
        .unwrap();
    let metadata = std::fs::metadata(&path).unwrap();
    IngestRepo::create(
        harness.env.meta.as_ref(),
        IngestFile {
            id: uuid::Uuid::now_v7().to_string(),
            batch_id: None,
            source_id: Some(local_id.clone()),
            upload_id: None,
            collection: COLLECTION.to_owned(),
            rel_path: "local/note.md".to_owned(),
            abs_path: path.to_string_lossy().into_owned(),
            size: metadata.len(),
            sha256: None,
            state: IngestState::Done,
            error: None,
            chunks: 0,
            extract_meta: None,
            derived_from: None,
            vectors: 0,
            elapsed_ms: None,
            created_at: 1,
            updated_at: 1,
        },
    )
    .await
    .unwrap();
    let entry = kb_core::model::ScanEntry {
        path: path.clone(),
        relative: "local/note.md".to_owned(),
        size: metadata.len(),
        mtime: kb_service::index::millis_of(&metadata),
        lang: "markdown".to_owned(),
        kind: kb_index::lang::kind_of(&path),
    };
    harness
        .service_index()
        .index_entry_with(
            "",
            &collection,
            &entry,
            &kb_service::index::FileIndexSpec {
                source: "local/note.md".to_owned(),
                kind: entry.kind,
                tags: Vec::new(),
            },
            1,
        )
        .await
        .unwrap();
    assert!(harness.indexed("local/note.md").await);

    let actions = harness
        .service
        .actions(COLLECTION, "local/note.md")
        .await
        .unwrap();
    assert_eq!(actions.origin, kb_core::model::FileOrigin::LocalDir);
    assert!(actions.delete.allowed);
    assert!(!actions.r#move.allowed, "本地目录文件不能移动");
    harness
        .service
        .delete_file(COLLECTION, "local/note.md", &actions.fingerprint.value)
        .await
        .unwrap();
    assert!(!harness.indexed("local/note.md").await);
    assert!(path.exists(), "本地目录删除不能动原件");
    assert!(
        harness
            .env
            .meta
            .path_excluded(COLLECTION, &local_id, "local/note.md")
            .await
            .unwrap(),
        "应记下精确路径排除,防止同步又加回来"
    );

    // 只移索引的条目也要能从回收站恢复:恢复后排除标记消失、索引重建,原件始终没动。
    let trash = harness
        .service
        .list_trash(Some(COLLECTION), kb_core::model::Page::new(50, 0))
        .await
        .unwrap();
    assert_eq!(trash.len(), 1);
    assert_eq!(trash[0].mode, kb_core::model::TrashMode::Unindex);
    harness
        .service
        .restore(&trash[0].id)
        .await
        .expect("恢复本地文件");
    assert!(path.exists(), "恢复不能搬动本地原件");
    assert!(
        !harness
            .env
            .meta
            .path_excluded(COLLECTION, &local_id, "local/note.md")
            .await
            .unwrap(),
        "恢复后要撤掉排除标记"
    );
    assert!(harness.indexed("local/note.md").await, "恢复后要重新索引");
}

#[tokio::test]
async fn move_rekeys_versions_to_new_path() {
    let harness = Harness::new().await;
    harness.add("docs/a.md", "# A\n").await;
    // 造一条旧版本:source 与 item_id 都要跟着移动走
    let item_id = format!("file:{COLLECTION}:docs/a.md");
    VersionRepo::create(
        harness.env.meta.as_ref(),
        kb_core::model::ItemVersion {
            id: "v1".to_owned(),
            item_id: item_id.clone(),
            collection: COLLECTION.to_owned(),
            source: "docs/a.md".to_owned(),
            version: 1,
            title: None,
            body: "# A\n".to_owned(),
            tags: Vec::new(),
            author: Some("tester".to_owned()),
            batch_id: None,
            created_at: 1,
        },
    )
    .await
    .unwrap();
    let actions = harness
        .service
        .actions(COLLECTION, "docs/a.md")
        .await
        .unwrap();
    harness
        .service
        .move_file(
            COLLECTION,
            "docs/a.md",
            COLLECTION,
            "archive",
            None,
            &actions.fingerprint.value,
        )
        .await
        .unwrap();
    let latest = VersionRepo::latest_version(
        harness.env.meta.as_ref(),
        &format!("file:{COLLECTION}:archive/a.md"),
    )
    .await
    .unwrap();
    assert_eq!(latest, 1, "版本历史应跟到新路径");
    assert!(
        VersionRepo::latest_version(harness.env.meta.as_ref(), &item_id)
            .await
            .unwrap()
            == 0
    );
    assert_eq!(item_id, format!("file:{COLLECTION}:docs/a.md"));
}

#[tokio::test]
async fn trash_entries_expire_and_purge() {
    let harness = Harness::new().await;
    harness.add("docs/a.md", "# A\n").await;
    // 删除时版本 / 批注会挪到 `trash:<id>` 隐藏键;彻底删除必须把隐藏键一起清掉,
    // 不能只删磁盘上的文件。
    VersionRepo::create(
        harness.env.meta.as_ref(),
        kb_core::model::ItemVersion {
            id: "v-trash".to_owned(),
            item_id: format!("file:{COLLECTION}:docs/a.md"),
            collection: COLLECTION.to_owned(),
            source: "docs/a.md".to_owned(),
            version: 1,
            title: None,
            body: "# A\n".to_owned(),
            tags: Vec::new(),
            author: Some("tester".to_owned()),
            batch_id: None,
            created_at: 1,
        },
    )
    .await
    .unwrap();
    AnnotationRepo::create(
        harness.env.meta.as_ref(),
        kb_core::model::Annotation {
            id: "a0000000-0000-7000-8000-000000000001".to_owned(),
            collection: COLLECTION.to_owned(),
            source: "docs/a.md".to_owned(),
            anchor: None,
            body: "这条评论要跟着文件一起彻底删掉".to_owned(),
            author: Some("tester".to_owned()),
            record_id: None,
            parent_id: None,
            resolved_at: None,
            resolved_by: None,
            mentions: Vec::new(),
            created_at: 1,
            updated_at: 1,
        },
    )
    .await
    .unwrap();
    let actions = harness
        .service
        .actions(COLLECTION, "docs/a.md")
        .await
        .unwrap();
    harness
        .service
        .delete_file(COLLECTION, "docs/a.md", &actions.fingerprint.value)
        .await
        .unwrap();
    let trash = FileOpsRepo::list_trash(
        harness.env.meta.as_ref(),
        Some(COLLECTION),
        kb_core::model::Page::new(50, 0),
    )
    .await
    .unwrap();
    assert_eq!(trash.len(), 1);
    let hidden_item = format!("file:{COLLECTION}:{}", trash[0].metadata_key);
    assert_eq!(
        VersionRepo::latest_version(harness.env.meta.as_ref(), &hidden_item)
            .await
            .unwrap(),
        1,
        "删除后版本历史应在隐藏键上留着,恢复才能接上"
    );
    assert!(
        IngestRepo::get_by_path(
            harness.env.meta.as_ref(),
            COLLECTION,
            &trash[0].metadata_key
        )
        .await
        .unwrap()
        .is_some(),
        "删除后解析记录也要挪到隐藏键,彻底删除时才知道该删哪行"
    );
    assert_eq!(
        AnnotationRepo::list_by_source(
            harness.env.meta.as_ref(),
            COLLECTION,
            &trash[0].metadata_key,
            10
        )
        .await
        .unwrap()
        .len(),
        1
    );
    let removed = harness.service.purge_expired(100).await.unwrap();
    assert_eq!(removed, 0, "30 天内不能清理");
    harness.service.purge(&trash[0].id).await.unwrap();
    assert!(!std::path::Path::new(trash[0].trash_path.as_deref().unwrap()).exists());
    assert!(
        !std::path::Path::new(trash[0].trash_path.as_deref().unwrap())
            .parent()
            .expect("回收站条目目录")
            .exists(),
        "彻底删除后空的条目目录也要收掉"
    );
    assert!(
        IngestRepo::get_by_path(
            harness.env.meta.as_ref(),
            COLLECTION,
            &trash[0].metadata_key
        )
        .await
        .unwrap()
        .is_none(),
        "彻底删除要清掉隐藏键上的解析记录"
    );
    assert_eq!(
        VersionRepo::latest_version(harness.env.meta.as_ref(), &hidden_item)
            .await
            .unwrap(),
        0,
        "彻底删除要清掉隐藏键上的版本"
    );
    assert!(
        AnnotationRepo::list_by_source(
            harness.env.meta.as_ref(),
            COLLECTION,
            &trash[0].metadata_key,
            10
        )
        .await
        .unwrap()
        .is_empty(),
        "彻底删除要清掉隐藏键上的批注"
    );
    let after = harness
        .service
        .list_trash(Some(COLLECTION), kb_core::model::Page::new(50, 0))
        .await
        .unwrap();
    assert!(after.is_empty());
}

#[tokio::test]
async fn a_failed_folder_move_rolls_back_the_files_already_moved() {
    let harness = Harness::new().await;
    harness.add("docs/a.md", "# A\n\n第一个。\n").await;
    harness.add("docs/b.md", "# B\n\n第二个。\n").await;
    // 目标目录里预先放一个同名目录:第一个文件能移过去,第二个会在物理移动前失败,
    // 用来看已经搬走的 a.md 是否被回滚回 docs/。
    std::fs::create_dir_all(harness.root.join("x/docs/b.md")).expect("占位目录");
    let actions = harness
        .service
        .actions(COLLECTION, "docs")
        .await
        .expect("菜单");
    let err = harness
        .service
        .move_folder(
            COLLECTION,
            "docs",
            COLLECTION,
            "x",
            None,
            &actions.fingerprint.value,
        )
        .await
        .expect_err("第二个文件应失败");
    assert!(matches!(err, kb_core::KbError::Exists(_)), "{err:?}");
    assert!(harness.root.join("docs/a.md").exists(), "a.md 要搬回原位");
    assert!(
        !harness.root.join("x/docs/a.md").exists(),
        "x/docs/a.md 应被撤掉"
    );
    assert!(harness.root.join("docs/b.md").exists(), "b.md 没动");
    assert!(harness.indexed("docs/a.md").await, "回滚后要重建索引");
    assert!(!harness.indexed("x/docs/a.md").await, "回滚后不能留新索引");
    let ops = harness
        .service
        .list_trash(Some(COLLECTION), kb_core::model::Page::new(50, 0))
        .await
        .expect("回收站");
    assert!(ops.is_empty(), "移动失败不能产生回收站条目");
}

#[tokio::test]
async fn a_stale_fingerprint_is_a_conflict_and_nothing_is_deleted() {
    let harness = Harness::new().await;
    harness.add("docs/a.md", "# A\n\n第一段内容。\n").await;
    let actions = harness
        .service
        .actions(COLLECTION, "docs/a.md")
        .await
        .expect("菜单");

    // 菜单打开后文件被同步 / 别人改过:旧指纹必须拒绝,不能拿旧判断去删新内容。
    // 即使同步还没更新索引,磁盘的 size / mtime 也已经变了。
    std::fs::write(
        harness.root.join("docs/a.md"),
        "# A\n\n改过的内容,而且更长一些。\n",
    )
    .expect("改文件");

    let err = harness
        .service
        .delete_file(COLLECTION, "docs/a.md", &actions.fingerprint.value)
        .await
        .expect_err("旧指纹应该冲突");
    assert!(matches!(err, kb_core::KbError::Conflict { .. }), "{err:?}");
    assert!(harness.root.join("docs/a.md").exists(), "冲突时不能删原件");
    assert!(harness.indexed("docs/a.md").await, "冲突时不能动索引");

    // 重新取指纹后可以正常删
    let fresh = harness
        .service
        .actions(COLLECTION, "docs/a.md")
        .await
        .expect("菜单");
    assert_ne!(fresh.fingerprint.value, actions.fingerprint.value);
    let op = harness
        .service
        .delete_file(COLLECTION, "docs/a.md", &fresh.fingerprint.value)
        .await
        .expect("删除");
    assert_eq!(op.state, FileOpState::Done);
}

/// 跨知识库移动:物理文件、索引、版本、批注、解析队列和批注检索行必须一起换库。
#[tokio::test]
async fn moves_file_across_collections_and_rekeys_all_derived_data() {
    let harness = Harness::new().await;
    harness.add("docs/a.md", "# A\n\n跨库移动。\n").await;
    let target = kb_service::CollectionService::new(
        harness.env.meta.clone(),
        harness.env.store.clone(),
        harness.env.embedder.clone(),
    )
    .create("proj_other", kb_core::model::CollectionKind::Project, None)
    .await
    .expect("建目标集合");
    let old = CollectionRepo::get(harness.env.meta.as_ref(), COLLECTION)
        .await
        .unwrap()
        .unwrap();

    let version_id = "v-cross-1".to_owned();
    VersionRepo::create(
        harness.env.meta.as_ref(),
        kb_core::model::ItemVersion {
            id: version_id.clone(),
            item_id: format!("file:{COLLECTION}:docs/a.md"),
            collection: COLLECTION.to_owned(),
            source: "docs/a.md".to_owned(),
            version: 1,
            title: None,
            body: "# A\n".to_owned(),
            tags: Vec::new(),
            author: Some("tester".to_owned()),
            batch_id: None,
            created_at: 1,
        },
    )
    .await
    .unwrap();
    let annotation_id = "a0000000-0000-7000-8000-0000000000c1".to_owned();
    AnnotationRepo::create(
        harness.env.meta.as_ref(),
        kb_core::model::Annotation {
            id: annotation_id.clone(),
            collection: COLLECTION.to_owned(),
            source: "docs/a.md".to_owned(),
            anchor: None,
            body: "这条批注要跟着文件换库".to_owned(),
            author: Some("tester".to_owned()),
            record_id: None,
            parent_id: None,
            resolved_at: None,
            resolved_by: None,
            mentions: Vec::new(),
            created_at: 1,
            updated_at: 1,
        },
    )
    .await
    .unwrap();

    let actions = harness
        .service
        .actions(COLLECTION, "docs/a.md")
        .await
        .unwrap();
    let op = harness
        .service
        .move_file(
            COLLECTION,
            "docs/a.md",
            "proj_other",
            "",
            None,
            &actions.fingerprint.value,
        )
        .await
        .expect("跨库移动");
    assert_eq!(op.state, FileOpState::Done);
    assert_eq!(op.collection, COLLECTION);
    assert_eq!(op.target_collection.as_deref(), Some("proj_other"));
    assert!(!harness.root.join("a.md").exists(), "原库物理文件应已移走");
    assert!(!harness.indexed("docs/a.md").await, "原库索引应已移除");

    let source = SourceRepo::get_by_name(harness.env.meta.as_ref(), "move:proj_other")
        .await
        .unwrap()
        .expect("目标库托管数据源");
    assert_eq!(source.collection, "proj_other");
    let target_abs = harness.env.paths().source_dir(&source.id).join("a.md");
    assert!(target_abs.exists(), "物理文件应在目标库数据源目录");
    assert!(
        FileRepo::get(harness.env.meta.as_ref(), "proj_other", "a.md")
            .await
            .unwrap()
            .is_some(),
        "目标库应有文件索引"
    );

    let ingest = IngestRepo::get_by_path(harness.env.meta.as_ref(), "proj_other", "a.md")
        .await
        .unwrap()
        .expect("解析队列应换库");
    assert_eq!(ingest.source_id.as_deref(), Some(source.id.as_str()));
    assert_eq!(ingest.abs_path, target_abs.to_string_lossy());
    assert!(ingest.batch_id.is_none(), "跨库后必须脱离原上传批次");
    assert!(ingest.upload_id.is_none());

    let versions = VersionRepo::list_by_source(harness.env.meta.as_ref(), "proj_other", "a.md", 10)
        .await
        .unwrap();
    assert_eq!(versions.len(), 1);
    assert_eq!(versions[0].id, version_id);
    assert_eq!(versions[0].item_id, "file:proj_other:a.md");

    let annotations =
        AnnotationRepo::list_by_source(harness.env.meta.as_ref(), "proj_other", "a.md", 10)
            .await
            .unwrap();
    assert_eq!(annotations.len(), 1);
    assert_eq!(annotations[0].id, annotation_id, "批注 id 必须保持不变");
    let old_rows = harness
        .env
        .store
        .get(&old.active_table, std::slice::from_ref(&annotation_id))
        .await
        .unwrap();
    assert!(old_rows.is_empty(), "原库批注检索行应删除");
    let new_rows = harness
        .env
        .store
        .get(&target.active_table, std::slice::from_ref(&annotation_id))
        .await
        .unwrap();
    assert_eq!(new_rows.len(), 1, "目标库应重建批注检索行");
    assert_eq!(
        new_rows[0].source,
        "a.md#annotation:a0000000-0000-7000-8000-0000000000c1"
    );
    assert_eq!(new_rows[0].collection, "proj_other");
}

/// 跨知识库移动整个文件夹:目标库按目标目录重建每个文件的索引与解析队列。
#[tokio::test]
async fn moves_folder_across_collections() {
    let harness = Harness::new().await;
    harness.add("docs/a.md", "# A\n").await;
    harness.add("docs/sub/b.md", "# B\n").await;
    harness.add("docs2/c.md", "# C\n").await;
    let target = kb_service::CollectionService::new(
        harness.env.meta.clone(),
        harness.env.store.clone(),
        harness.env.embedder.clone(),
    )
    .create("proj_other", kb_core::model::CollectionKind::Project, None)
    .await
    .expect("建目标集合");

    let actions = harness.service.actions(COLLECTION, "docs").await.unwrap();
    let op = harness
        .service
        .move_folder(
            COLLECTION,
            "docs",
            "proj_other",
            "archive",
            Some("recovered"),
            &actions.fingerprint.value,
        )
        .await
        .expect("跨库移动文件夹");
    assert_eq!(op.state, FileOpState::Done);
    assert_eq!(op.target_collection.as_deref(), Some("proj_other"));

    for path in ["archive/recovered/a.md", "archive/recovered/sub/b.md"] {
        assert!(
            FileRepo::get(harness.env.meta.as_ref(), "proj_other", path)
                .await
                .unwrap()
                .is_some(),
            "目标库应有 {path}"
        );
        assert!(
            IngestRepo::get_by_path(harness.env.meta.as_ref(), "proj_other", path)
                .await
                .unwrap()
                .is_some(),
            "目标库解析队列应有 {path}"
        );
    }
    assert!(!harness.indexed("docs/a.md").await);
    assert!(!harness.indexed("docs/sub/b.md").await);
    assert!(harness.indexed("docs2/c.md").await, "docs2 不能被一起搬走");
    assert!(harness.root.join("docs2/c.md").exists());

    let source = SourceRepo::get_by_name(harness.env.meta.as_ref(), "move:proj_other")
        .await
        .unwrap()
        .expect("目标库托管数据源");
    assert!(
        harness
            .env
            .paths()
            .source_dir(&source.id)
            .join("archive/recovered/a.md")
            .exists()
    );
    assert_eq!(
        CollectionRepo::get(harness.env.meta.as_ref(), "proj_other")
            .await
            .unwrap()
            .unwrap()
            .active_table,
        target.active_table
    );
}
