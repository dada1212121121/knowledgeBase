//! 协作落地到笔记正文 / 文本文件,以及基线与保存点。

use std::sync::Arc;

use kb_core::KbError;
use kb_core::ports::repo::{InsightRepo, VersionRepo};
use kb_service::IndexService;
use kb_service::edit::{FileEditService, SaveFileRequest};
use kb_service::index::IndexOptions;
use kb_service::insight::{InsightService, SaveInsightRequest};
use kb_service::items::{ItemService, MAX_LANDED_BODY_BYTES};
use kb_testkit::TestEnv;

const COLLECTION: &str = "_global";

async fn env() -> TestEnv {
    let env = TestEnv::new().await;
    kb_service::CollectionService::new(env.meta.clone(), env.store.clone(), env.embedder.clone())
        .ensure_global()
        .await
        .expect("建 _global");
    env
}

async fn new_note(env: &TestEnv, body: &str) -> String {
    InsightService::new(env.meta.clone(), env.store.clone(), env.embedder.clone())
        .save(SaveInsightRequest {
            title: "协作笔记".to_owned(),
            body_md: body.to_owned(),
            kind: None,
            project: None,
            global: true,
            collection: None,
            tags: vec!["t".to_owned()],
            related_paths: Vec::new(),
            supersedes: None,
            created_by: "user".to_owned(),
            cwd: None,
            strict_links: false,
        })
        .await
        .expect("建笔记")
        .id
}

fn items(env: &TestEnv) -> ItemService {
    ItemService::new(env.meta.clone(), env.store.clone(), env.embedder.clone())
}

#[tokio::test]
async fn landing_writes_the_body_bumps_the_version_and_skips_unchanged_content() {
    let env = env().await;
    let id = new_note(&env, "原文").await;
    let service = items(&env);
    let before = InsightRepo::get(env.meta.as_ref(), &id)
        .await
        .unwrap()
        .unwrap();
    // 没变化:不写、不涨版本
    let (written, hash) = service.land_insight(&id, "原文").await.unwrap();
    assert!(!written);
    assert_eq!(hash, kb_core::hash::content_hash("原文"));
    assert_eq!(
        InsightRepo::get(env.meta.as_ref(), &id)
            .await
            .unwrap()
            .unwrap()
            .version,
        before.version
    );
    // 有变化:写入并涨版本——协作者落地之后,拿旧版本号的 API 写入必须冲突,不能悄悄覆盖
    let (written, _) = service
        .land_insight(&id, "协作后的正文\n\n第二段")
        .await
        .unwrap();
    assert!(written);
    let after = InsightRepo::get(env.meta.as_ref(), &id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(after.body_md, "协作后的正文\n\n第二段");
    assert_eq!(after.version, before.version + 1);
    assert_eq!(after.title, before.title, "落地只动正文");
    assert_eq!(after.tags, before.tags);
    let stale = service
        .edit(
            kb_service::items::EditRequest {
                id: id.clone(),
                version: Some(before.version),
                title: None,
                body: Some("过期的写入".to_owned()),
                tags: None,
                kind: None,
                author: None,
            },
            None,
        )
        .await;
    assert!(matches!(stale, Err(KbError::Conflict { .. })), "{stale:?}");
    // 清空正文也能落地(用户删光了内容),不是报错卡住
    let (written, _) = service.land_insight(&id, "").await.unwrap();
    assert!(written);
    assert_eq!(service.insight_body(&id).await.unwrap(), "");
    // 不存在的笔记
    assert!(matches!(
        service.land_insight("nope", "x").await,
        Err(KbError::NotFound(_))
    ));
}

#[tokio::test]
async fn landing_refuses_an_oversized_body_and_leaves_the_note_alone() {
    let env = env().await;
    let id = new_note(&env, "原文").await;
    let service = items(&env);
    let huge = "x".repeat(MAX_LANDED_BODY_BYTES + 1);
    assert!(matches!(
        service.land_insight(&id, &huge).await,
        Err(KbError::InvalidInput(_))
    ));
    assert_eq!(service.insight_body(&id).await.unwrap(), "原文");
}

#[tokio::test]
async fn baseline_is_recorded_once_and_savepoints_dedupe_by_content() {
    let env = env().await;
    let id = new_note(&env, "协作之前").await;
    let service = items(&env);
    let source = format!("insight:{id}");
    service.insight_baseline(&id, "baseline").await.unwrap();
    service.insight_baseline(&id, "baseline").await.unwrap();
    let versions = VersionRepo::list_by_source(env.meta.as_ref(), COLLECTION, &source, 10)
        .await
        .unwrap();
    assert_eq!(versions.len(), 1, "基线只记一次");
    assert_eq!(versions[0].body, "协作之前");
    assert_eq!(versions[0].author.as_deref(), Some("baseline"));
    // 没有变化就不生成保存点
    assert!(!service.insight_savepoint(&id, "alice").await.unwrap());
    // 落地后保存点记录参与者与新内容
    service.land_insight(&id, "协作之后").await.unwrap();
    assert!(service.insight_savepoint(&id, "alice、bob").await.unwrap());
    assert!(
        !service.insight_savepoint(&id, "alice、bob").await.unwrap(),
        "同样的内容不重复记"
    );
    let versions = VersionRepo::list_by_source(env.meta.as_ref(), COLLECTION, &source, 10)
        .await
        .unwrap();
    assert_eq!(versions.len(), 2);
    assert_eq!(versions[0].body, "协作之后");
    assert_eq!(versions[0].version, 2);
    assert_eq!(versions[0].author.as_deref(), Some("alice、bob"));
    assert_eq!(versions[1].body, "协作之前", "之前的样子还在,可以恢复");
}

#[tokio::test]
async fn reindexing_after_landing_queues_one_embedding_job() {
    let env = env().await;
    let id = new_note(&env, "原文").await;
    let service = items(&env);
    service.land_insight(&id, "新正文").await.unwrap();
    let job = service.reindex_insight(&id).await.unwrap();
    assert!(job.is_some());
    assert_eq!(service.reindex_insight("nope").await.unwrap(), None);
}

struct Files {
    env: TestEnv,
    edits: FileEditService,
}

async fn files() -> Files {
    let env = env().await;
    let index = Arc::new(IndexService::new(
        env.meta.clone(),
        env.store.clone(),
        env.embedder.clone(),
        env.chunker.clone(),
        env.scanner.clone(),
        IndexOptions::default(),
    ));
    let edits = FileEditService::new(env.meta.clone(), index, env.paths());
    Files { env, edits }
}

fn write_source(files: &Files, rel: &str, content: &str) -> std::path::PathBuf {
    let dir = files.env.paths().sources_dir().join("collab-test");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(rel);
    std::fs::write(&path, content).unwrap();
    path
}

#[tokio::test]
async fn text_files_land_without_versions_and_get_a_version_only_at_the_savepoint() {
    let files = files().await;
    let path = write_source(&files, "notes.md", "# 起点\n");
    assert_eq!(
        files.edits.read_text(COLLECTION, "notes.md").await.unwrap(),
        "# 起点\n"
    );
    files.edits.baseline(COLLECTION, "notes.md").await.unwrap();
    files.edits.baseline(COLLECTION, "notes.md").await.unwrap();
    // 落地:写文件,内容没变不写,不产生版本
    let (written, hash) = files
        .edits
        .land(COLLECTION, "notes.md", "# 起点\n")
        .await
        .unwrap();
    assert!(!written);
    assert_eq!(hash, kb_core::hash::content_hash("# 起点\n"));
    let (written, _) = files
        .edits
        .land(COLLECTION, "notes.md", "# 起点\n\n协作加的")
        .await
        .unwrap();
    assert!(written);
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "# 起点\n\n协作加的"
    );
    let versions = files
        .edits
        .versions(COLLECTION, "notes.md", 10)
        .await
        .unwrap();
    assert_eq!(versions.len(), 1, "落地不生成版本,只有基线");
    // 保存点:记一版,参与者写在作者里;重复不记
    assert!(
        files
            .edits
            .savepoint(COLLECTION, "notes.md", "alice、bob")
            .await
            .unwrap()
    );
    assert!(
        !files
            .edits
            .savepoint(COLLECTION, "notes.md", "alice、bob")
            .await
            .unwrap()
    );
    let versions = files
        .edits
        .versions(COLLECTION, "notes.md", 10)
        .await
        .unwrap();
    assert_eq!(versions.len(), 2);
    assert_eq!(versions[0].author.as_deref(), Some("alice、bob"));
    assert_eq!(versions[1].body, "# 起点\n");
    // 恢复到基线仍然走原来的路径,版本号继续往上
    let restored = files.edits.restore(&versions[1].id, "alice").await.unwrap();
    assert_eq!(restored.version, 3);
    // 重新索引可以单独调用
    let (_embedded, chunks) = files
        .edits
        .reindex_file(COLLECTION, "notes.md")
        .await
        .unwrap();
    assert!(chunks >= 1);
    // 不存在的文件
    assert!(
        files
            .edits
            .land(COLLECTION, "missing.md", "x")
            .await
            .is_err()
    );
    // 原来的 save 路径不受影响
    let saved = files
        .edits
        .save(SaveFileRequest {
            collection: COLLECTION.to_owned(),
            path: "notes.md".to_owned(),
            content: "# 直接保存\n".to_owned(),
            expected_version: Some(3),
            author: "alice".to_owned(),
            tags: Vec::new(),
        })
        .await
        .unwrap();
    assert_eq!(saved.version, 4);
}
