//! `kb index --global` 的增量行为。

use std::sync::Arc;

use kb_core::KbError;
use kb_core::model::{Collection, ItemStatus, RecordKind};
use kb_core::ports::repo::ChunkRepo;
use kb_service::{CollectionService, IndexOptions, IndexService};
use kb_testkit::TestEnv;
use tempfile::TempDir;

async fn setup() -> (TestEnv, TempDir, Collection, Arc<IndexService>) {
    let env = TestEnv::new().await;
    let dir = tempfile::tempdir().expect("文档目录");
    let global = CollectionService::new(env.meta.clone(), env.store.clone(), env.embedder.clone())
        .ensure_global()
        .await
        .expect("_global");
    let service = Arc::new(IndexService::new(
        env.meta.clone(),
        env.store.clone(),
        env.embedder.clone(),
        env.chunker.clone(),
        env.scanner.clone(),
        IndexOptions::default(),
    ));
    (env, dir, global, service)
}

fn write(dir: &TempDir, name: &str, content: &str) -> std::path::PathBuf {
    let path = dir.path().join(name);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("建目录");
    }
    std::fs::write(&path, content).expect("写文件");
    path
}

#[tokio::test]
async fn importing_twice_does_not_reembed() {
    let (env, dir, global, service) = setup().await;
    let path = write(&dir, "guide.md", "# 指南\n\n## 双哈希\n\n只更新元数据。\n");

    let first = service
        .index_global_path(&global, &path, &["文档".to_owned()])
        .await
        .expect("第一次导入");
    assert_eq!(first.indexed_files, 1);
    assert_eq!(first.embedded, first.chunks);
    assert!(first.chunks >= 2);

    env.fake.reset_count();
    let second = service
        .index_global_path(&global, &path, &["文档".to_owned()])
        .await
        .expect("第二次导入");
    assert_eq!(second.embedded, 0, "文件没变不应重新嵌入");
    assert_eq!(env.fake.embedding_count(), 0);
}

#[tokio::test]
async fn changing_tags_updates_metadata_without_reembedding() {
    let (env, dir, global, service) = setup().await;
    let path = write(&dir, "guide.md", "# 指南\n\n## 一节\n\n正文\n");
    service
        .index_global_path(&global, &path, &["old".to_owned()])
        .await
        .expect("第一次导入");
    env.fake.reset_count();

    let report = service
        .index_global_path(&global, &path, &["new".to_owned()])
        .await
        .expect("第二次导入");
    assert_eq!(report.embedded, 0, "只改标签不应重新嵌入");
    assert!(report.updated_meta >= 1, "应走 update_meta");
    assert_eq!(env.fake.embedding_count(), 0);

    let chunks = ChunkRepo::by_path(env.meta.as_ref(), "_global", "guide.md")
        .await
        .expect("读块");
    let rows = env
        .store
        .get(
            &global.active_table,
            &chunks
                .iter()
                .map(|chunk| chunk.id.clone())
                .collect::<Vec<_>>(),
        )
        .await
        .expect("查");
    assert!(
        rows.iter().all(|row| row.tags == ["new"]),
        "标签应更新为 new,实际 {:?}",
        rows.iter().map(|row| row.tags.clone()).collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn shortening_a_file_removes_orphan_rows() {
    let (env, dir, global, service) = setup().await;
    let path = write(
        &dir,
        "guide.md",
        "# 指南\n\n## 一\n\n正文一\n\n## 二\n\n正文二\n\n## 三\n\n正文三\n",
    );
    let first = service
        .index_global_path(&global, &path, &[])
        .await
        .expect("导入");
    assert!(first.chunks >= 4, "chunks={}", first.chunks);
    let before = env
        .store
        .count(&global.active_table, None)
        .await
        .expect("计数");

    // 文件变短:只剩一个小节
    write(&dir, "guide.md", "# 指南\n\n## 一\n\n正文一\n");
    let second = service
        .index_global_path(&global, &path, &[])
        .await
        .expect("再次导入");
    assert!(second.deleted_chunks >= 1, "应删除旧块");

    let after = env
        .store
        .count(&global.active_table, None)
        .await
        .expect("计数");
    let sqlite_rows = ChunkRepo::by_path(env.meta.as_ref(), "_global", "guide.md")
        .await
        .expect("读块")
        .len() as u64;
    assert_eq!(after, sqlite_rows, "LanceDB 与 chunks 表应一致(没有孤儿行)");
    assert!(after < before);
}

#[tokio::test]
async fn text_and_rst_files_are_documents() {
    let (env, dir, global, service) = setup().await;
    let txt = write(&dir, "notes.txt", "第一行\n第二行\n");
    let rst = write(&dir, "readme.rst", "标题\n====\n\n正文\n");
    service
        .index_global_path(&global, &txt, &[])
        .await
        .expect("导入 txt");
    service
        .index_global_path(&global, &rst, &[])
        .await
        .expect("导入 rst");

    for source in ["notes.txt", "readme.rst"] {
        let chunks = ChunkRepo::by_path(env.meta.as_ref(), "_global", source)
            .await
            .expect("读块");
        assert!(!chunks.is_empty(), "{source} 应有块");
        let rows = env
            .store
            .get(
                &global.active_table,
                &chunks
                    .iter()
                    .map(|chunk| chunk.id.clone())
                    .collect::<Vec<_>>(),
            )
            .await
            .expect("查 LanceDB");
        assert!(
            rows.iter().all(|row| row.kind == RecordKind::Doc),
            "{source} 的 kind 应为 doc,实际 {:?}",
            rows.iter().map(|row| row.kind).collect::<Vec<_>>()
        );
        assert!(rows.iter().all(|row| row.status == ItemStatus::Active));
    }
}

#[tokio::test]
async fn duplicate_file_names_in_a_directory_are_rejected() {
    let (env, dir, global, service) = setup().await;
    write(&dir, "a/guide.md", "# A\n");
    write(&dir, "b/guide.md", "# B\n");
    let error = service
        .index_global_path(&global, dir.path(), &[])
        .await
        .expect_err("同名文件应报错");
    assert!(matches!(error, KbError::InvalidInput(_)), "{error:?}");
    let _ = env;
}

#[tokio::test]
async fn directory_import_indexes_every_document() {
    let (env, dir, global, service) = setup().await;
    write(&dir, "a.md", "# A\n");
    write(&dir, "sub/b.txt", "b\n");
    let report = service
        .index_global_path(&global, dir.path(), &["标签".to_owned()])
        .await
        .expect("目录导入");
    assert_eq!(report.indexed_files, 2);
    let chunks = ChunkRepo::by_path(env.meta.as_ref(), "_global", "a.md")
        .await
        .expect("读块");
    assert_eq!(chunks.len(), 1);
    let rows = env
        .store
        .get(&global.active_table, &[chunks[0].id.clone()])
        .await
        .expect("查");
    assert_eq!(rows[0].tags, ["标签"]);
}
