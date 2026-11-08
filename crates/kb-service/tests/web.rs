//! Web 侧后端能力的验收测试(条目读写、批量标签与撤销、概览、审计、令牌)。

use std::sync::Arc;

use kb_core::model::{InsightKind, ItemStatus, Page, Project, RecordKind};
use kb_core::ports::repo::{
    AuditRepo, AuthRepo, ChunkRepo, CollectionRepo, InsightRepo, ProjectRepo, VersionRepo,
};
use kb_service::items::{CreateRequest, EditRequest, ItemService, ListRequest};
use kb_service::revert::RevertService;
use kb_service::stats::StatsService;
use kb_service::{CollectionService, IndexOptions, IndexService, NoopReranker};
use kb_testkit::TestEnv;
use tempfile::TempDir;

struct Fixture {
    env: TestEnv,
    #[allow(dead_code)]
    dir: TempDir,
    project: Project,
    collection: kb_core::model::Collection,
}

/// 两个 Rust 文件的临时项目(各 1 块),外加建好的 collection。
async fn fixture() -> Fixture {
    fixture_with(&[]).await
}

/// 同 [`fixture`],再多放几个文件(相对路径, 内容)。
async fn fixture_with(extra: &[(&str, String)]) -> Fixture {
    let dir = tempfile::tempdir().expect("项目");
    std::fs::write(dir.path().join("a.rs"), "fn a() -> u32 {\n    1\n}\n").expect("写");
    std::fs::write(dir.path().join("b.rs"), "fn b() -> u32 {\n    2\n}\n").expect("写");
    for (path, content) in extra {
        std::fs::write(dir.path().join(path), content).expect("写");
    }
    let env = TestEnv::new().await;
    let project = Project {
        id: "p1".to_owned(),
        name: "demo".to_owned(),
        slug: "demo".to_owned(),
        root_path: dir.path().to_string_lossy().into_owned(),
        include: Vec::new(),
        exclude: Vec::new(),
        is_git: false,
        last_commit: None,
        last_indexed_at: None,
        allow_cloud_llm: false,
        extract_enabled: false,
        hooks_installed: false,
        created_at: 1_700_000_000_000,
    };
    ProjectRepo::create(env.meta.as_ref(), project.clone())
        .await
        .expect("写项目");
    let collection =
        CollectionService::new(env.meta.clone(), env.store.clone(), env.embedder.clone())
            .create_for_project("p1", "demo")
            .await
            .expect("建 collection");
    IndexService::new(
        env.meta.clone(),
        env.store.clone(),
        env.embedder.clone(),
        env.chunker.clone(),
        env.scanner.clone(),
        IndexOptions::default(),
    )
    .index_project(&project, &collection)
    .await
    .expect("索引");
    Fixture {
        env,
        dir,
        project,
        collection,
    }
}

/// 跑完队列里的任务(新建 / 编辑 insight 后的重新嵌入)。
async fn drain(env: &TestEnv) {
    let queue = kb_service::jobs::queue::JobQueue::new(env.meta.clone());
    let mut router = kb_service::jobs::worker::JobRouter::new();
    router.register(
        "index",
        Arc::new(kb_service::jobs::IndexJobHandler::new(
            Arc::new(IndexService::new(
                env.meta.clone(),
                env.store.clone(),
                env.embedder.clone(),
                env.chunker.clone(),
                env.scanner.clone(),
                IndexOptions::default(),
            )),
            env.meta.clone(),
            50,
        )),
    );
    router.register(
        "save_insight",
        Arc::new(kb_service::InsightJobHandler::new(
            env.meta.clone(),
            env.store.clone(),
            env.embedder.clone(),
        )),
    );
    let (_tx, rx) = tokio::sync::watch::channel(false);
    kb_service::jobs::worker::Worker::new(Arc::new(queue), Arc::new(router), rx)
        .run_until_idle()
        .await
        .expect("跑任务");
}

fn items(fixture: &Fixture) -> ItemService {
    ItemService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        fixture.env.embedder.clone(),
    )
}

fn list_request(collection: &str) -> ListRequest {
    ListRequest {
        collection: collection.to_owned(),
        kind: None,
        insight_kind: None,
        statuses: Vec::new(),
        path_prefix: None,
        tag: None,
        q: None,
        page: 1,
        page_size: 20,
        sort: None,
        ascending: false,
        group_by_file: false,
    }
}

#[tokio::test]
async fn list_filters_paginates_and_sorts() {
    let fixture = fixture().await;
    let service = items(&fixture);

    let mut request = list_request(&fixture.collection.name);
    request.page_size = 1;
    let first = service.list(request).await.expect("第一页");
    assert_eq!(first.total, 2, "两个文件应各有一条条目");
    assert_eq!(first.items.len(), 1, "每页 1 条");
    assert_eq!(first.page, 1);

    let mut request = list_request(&fixture.collection.name);
    request.page = 2;
    request.page_size = 1;
    let second = service.list(request).await.expect("第二页");
    assert_eq!(second.items.len(), 1);
    assert_ne!(first.items[0].id, second.items[0].id, "两页不应重复同一条");

    // 路径前缀过滤
    let mut request = list_request(&fixture.collection.name);
    request.path_prefix = Some("a".to_owned());
    let filtered = service.list(request).await.expect("前缀过滤");
    assert_eq!(filtered.total, 1);
    assert_eq!(filtered.items[0].source, "a.rs");
    assert_eq!(filtered.items[0].kind, RecordKind::Code);
}

/// 一份被切成好几块的 Markdown 手册:每节都写得足够长,分块器不会把它们合并掉。
fn long_manual() -> String {
    let mut text = String::from("# 操作手册\n\n开头说明。\n\n");
    for n in 1..=6 {
        text.push_str(&format!("## 第{n}章 流程\n\n"));
        for line in 0..14 {
            text.push_str(&format!("第{n}章第{line}条:先打开页面,再点击对应按钮并确认结果显示正确,出现异常时记录截图后联系管理员处理。\n\n"));
        }
    }
    text
}

#[tokio::test]
async fn list_by_file_shows_each_document_once_while_chunk_level_listing_still_sees_every_chunk() {
    let fixture = fixture_with(&[("guide.md", long_manual())]).await;
    let service = items(&fixture);
    let name = fixture.collection.name.clone();

    // 块级(默认):手册被切成多块,每块一行
    let mut chunked = list_request(&name);
    chunked.page_size = 200;
    let chunked = service.list(chunked).await.expect("块级");
    let manual_chunks = chunked
        .items
        .iter()
        .filter(|item| item.source == "guide.md")
        .count();
    assert!(manual_chunks >= 3, "手册应被切成多块,实际 {manual_chunks}");
    assert!(
        chunked.items.iter().all(|item| item.chunks.is_none()),
        "块级列表不带块数"
    );

    // 文件级:手册只出现一次,块数对得上,三个文件共三条
    let mut by_file = list_request(&name);
    by_file.group_by_file = true;
    by_file.page_size = 200;
    let files = service.list(by_file.clone()).await.expect("文件级");
    assert_eq!(files.total, 3, "a.rs / b.rs / guide.md 各一条");
    assert_eq!(files.items.len(), 3);
    let manual = files
        .items
        .iter()
        .find(|item| item.source == "guide.md")
        .expect("手册");
    assert_eq!(
        manual.chunks,
        Some(manual_chunks as u32),
        "块数要和块级看到的一致"
    );
    assert_eq!(
        manual.title.as_deref(),
        Some("操作手册"),
        "文档级标题只取最前面的总标题,不带「章 › 节」路径"
    );
    assert!(manual.symbol.is_none() && manual.start_line.is_none());
    for code in files
        .items
        .iter()
        .filter(|item| item.kind == RecordKind::Code)
    {
        assert_eq!(code.chunks, Some(1));
        assert!(
            code.title.is_none() && code.symbol.is_none(),
            "代码文件的符号只属于某一块,文件级不带"
        );
    }

    // 代表块就是第一块:用它的 id 取到的内容是手册的开头
    let first_chunk = chunked
        .items
        .iter()
        .filter(|item| item.source == "guide.md")
        .min_by_key(|item| item.start_line.unwrap_or(i32::MIN))
        .expect("第一块");
    assert_eq!(manual.id, first_chunk.id, "代表块是起始行最小的那块");
}

#[tokio::test]
async fn list_by_file_paginates_sorts_and_filters_on_files_not_chunks() {
    let fixture = fixture_with(&[("guide.md", long_manual())]).await;
    let service = items(&fixture);
    let name = fixture.collection.name.clone();

    // 翻页:每页 1 个文件,三页,不重复不遗漏
    let mut seen = Vec::new();
    for page in 1..=3 {
        let mut request = list_request(&name);
        request.group_by_file = true;
        request.page = page;
        request.page_size = 1;
        request.sort = Some("source".to_owned());
        request.ascending = true;
        let response = service.list(request).await.expect("翻页");
        assert_eq!(response.total, 3, "总数按文件算,不是按块算");
        assert_eq!(response.items.len(), 1);
        seen.push(response.items[0].source.clone());
    }
    assert_eq!(
        seen,
        ["a.rs", "b.rs", "guide.md"],
        "按 source 升序、翻页顺序稳定"
    );
    let mut beyond = list_request(&name);
    beyond.group_by_file = true;
    beyond.page = 4;
    beyond.page_size = 1;
    assert!(service.list(beyond).await.expect("越界页").items.is_empty());

    // 倒序
    let mut desc = list_request(&name);
    desc.group_by_file = true;
    desc.sort = Some("source".to_owned());
    desc.ascending = false;
    let desc = service.list(desc).await.expect("倒序");
    assert_eq!(
        desc.items
            .iter()
            .map(|i| i.source.as_str())
            .collect::<Vec<_>>(),
        ["guide.md", "b.rs", "a.rs"]
    );

    // 过滤条件按文件算:只看文档 → 1 个文件;路径前缀 → 对应的文件
    let mut docs = list_request(&name);
    docs.group_by_file = true;
    docs.kind = Some(RecordKind::Doc);
    let docs = service.list(docs).await.expect("只看文档");
    assert_eq!((docs.total, docs.items[0].source.as_str()), (1, "guide.md"));
    let mut prefix = list_request(&name);
    prefix.group_by_file = true;
    prefix.path_prefix = Some("b".to_owned());
    assert_eq!(service.list(prefix).await.expect("前缀").total, 1);

    // 非法排序列和块级列表一样报错
    let mut bad = list_request(&name);
    bad.group_by_file = true;
    bad.sort = Some("text".to_owned());
    assert!(matches!(
        service.list(bad).await,
        Err(kb_core::KbError::InvalidInput(_))
    ));
}

#[tokio::test]
async fn edit_insight_uses_optimistic_lock_and_reembeds() {
    let fixture = fixture().await;
    let service = items(&fixture);
    let created = service
        .create(
            CreateRequest {
                collection: Some(fixture.collection.name.clone()),
                project: None,
                global: false,
                title: "登录方式".to_owned(),
                body: "用 session cookie".to_owned(),
                kind: Some(InsightKind::Decision),
                tags: vec!["auth".to_owned()],
                related_paths: Vec::new(),
                created_by: "user".to_owned(),
                cwd: None,
            },
            None,
        )
        .await
        .expect("新建");
    assert_eq!(created.version, 1);

    // 正文改动 → 版本 +1 且投递重新嵌入任务
    let edited = service
        .edit(
            EditRequest {
                id: created.id.clone(),
                version: Some(1),
                title: None,
                body: Some("改成 bearer 令牌".to_owned()),
                tags: None,
                kind: None,
                author: None,
            },
            None,
        )
        .await
        .expect("编辑");
    assert_eq!(edited.version, 2);
    assert!(edited.job_id.is_some(), "正文变了要重新嵌入");

    // 旧版本号 → Conflict(HTTP 409)
    let err = service
        .edit(
            EditRequest {
                id: created.id.clone(),
                version: Some(1),
                title: None,
                body: Some("再改一次".to_owned()),
                tags: None,
                kind: None,
                author: None,
            },
            None,
        )
        .await
        .expect_err("版本不符必须失败");
    assert!(
        matches!(err, kb_core::KbError::Conflict { .. }),
        "应是 Conflict:{err:?}"
    );

    let stored = InsightRepo::get(fixture.env.meta.as_ref(), &created.id)
        .await
        .expect("读")
        .expect("存在");
    assert_eq!(stored.body_md, "改成 bearer 令牌");
    assert_eq!(stored.version, 2);

    // 每次真的改了内容都留一条版本历史:新建时就落了 v1(作者是新建的人),
    // 改动后接一条 —— 不再靠改动时补基线
    let history = VersionRepo::list_by_source(
        fixture.env.meta.as_ref(),
        &created.collection,
        &format!("insight:{}", created.id),
        10,
    )
    .await
    .expect("读版本");
    let bodies: Vec<&str> = history.iter().map(|row| row.body.as_str()).collect();
    assert_eq!(
        bodies,
        vec!["改成 bearer 令牌", "用 session cookie"],
        "版本历史应为 新→旧,且包含新建时那一条"
    );
    assert_eq!(history[0].author.as_deref(), Some("web"));
    assert_eq!(history[1].author.as_deref(), Some("user"));

    // 恢复到基线版:恢复本身是一次新编辑 —— 正文回到旧值,历史又多一条
    let restored = service
        .restore_insight_version(&history[1].id, "alice")
        .await
        .expect("恢复版本");
    assert_eq!(restored.version, 3);
    let stored = InsightRepo::get(fixture.env.meta.as_ref(), &created.id)
        .await
        .expect("读")
        .expect("存在");
    assert_eq!(stored.body_md, "用 session cookie");
    let history = VersionRepo::list_by_source(
        fixture.env.meta.as_ref(),
        &created.collection,
        &format!("insight:{}", created.id),
        10,
    )
    .await
    .expect("读版本");
    assert_eq!(history.len(), 3);
    assert_eq!(history[0].body, "用 session cookie");
    assert_eq!(history[0].author.as_deref(), Some("alice"));
}

#[tokio::test]
async fn edit_derived_item_only_allows_tags() {
    let fixture = fixture().await;
    let service = items(&fixture);
    let chunks = ChunkRepo::by_path(fixture.env.meta.as_ref(), &fixture.collection.name, "a.rs")
        .await
        .expect("读块");
    let id = chunks[0].id.clone();

    // 正文只读
    let err = service
        .edit(
            EditRequest {
                id: id.clone(),
                version: None,
                title: None,
                body: Some("篡改正文".to_owned()),
                tags: None,
                kind: None,
                author: None,
            },
            None,
        )
        .await
        .expect_err("代码块正文只读");
    assert!(matches!(err, kb_core::KbError::InvalidInput(_)), "{err:?}");

    // 只改标签可以
    let edited = service
        .edit(
            EditRequest {
                id: id.clone(),
                version: None,
                title: None,
                body: None,
                tags: Some(vec!["核心".to_owned()]),
                kind: None,
                author: None,
            },
            None,
        )
        .await
        .expect("改标签");
    assert_eq!(edited.id, id);
    let rows = fixture
        .env
        .store
        .get(&fixture.collection.active_table, &[id])
        .await
        .expect("读行");
    assert_eq!(rows[0].tags, vec!["核心".to_owned()]);
}

#[tokio::test]
async fn batch_tag_can_be_reverted() {
    let fixture = fixture().await;
    let service = items(&fixture);
    let mut ids = Vec::new();
    for path in ["a.rs", "b.rs"] {
        let chunks = ChunkRepo::by_path(fixture.env.meta.as_ref(), &fixture.collection.name, path)
            .await
            .expect("读块");
        ids.push(chunks[0].id.clone());
    }
    let batch = AuditRepo::begin_batch(fixture.env.meta.as_ref(), "user", "批量打标签")
        .await
        .expect("开批次");

    service
        .batch_tag(&ids, &["release-1".to_owned()], &[], Some(&batch))
        .await
        .expect("批量打标签");
    for id in &ids {
        let rows = fixture
            .env
            .store
            .get(&fixture.collection.active_table, std::slice::from_ref(id))
            .await
            .expect("读行");
        assert_eq!(rows[0].tags, vec!["release-1".to_owned()], "标签应已写入");
    }

    // 撤销:标签回到打标签之前
    let revert = RevertService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        fixture.env.embedder.clone(),
    );
    let report = revert.revert(&batch).await.expect("撤销批次");
    assert_eq!(report.reverted.len(), 2, "两条都要撤销:{report:?}");
    for id in &ids {
        let rows = fixture
            .env
            .store
            .get(&fixture.collection.active_table, std::slice::from_ref(id))
            .await
            .expect("读行");
        assert!(rows[0].tags.is_empty(), "标签应被撤销:{:?}", rows[0].tags);
    }
    let stored = AuditRepo::batch(fixture.env.meta.as_ref(), &batch)
        .await
        .expect("读批次")
        .expect("存在");
    assert!(stored.reverted_at.is_some(), "批次应标记已撤销");

    // 重复撤销报错
    let err = revert.revert(&batch).await.expect_err("不能撤销两次");
    assert!(matches!(err, kb_core::KbError::InvalidInput(_)), "{err:?}");
}

#[tokio::test]
async fn revert_restores_an_edited_insight() {
    let fixture = fixture().await;
    let service = items(&fixture);
    let created = service
        .create(
            CreateRequest {
                collection: Some(fixture.collection.name.clone()),
                project: None,
                global: false,
                title: "原标题".to_owned(),
                body: "原正文".to_owned(),
                kind: None,
                tags: Vec::new(),
                related_paths: Vec::new(),
                created_by: "user".to_owned(),
                cwd: None,
            },
            None,
        )
        .await
        .expect("新建");
    let batch = AuditRepo::begin_batch(fixture.env.meta.as_ref(), "user", "编辑条目")
        .await
        .expect("开批次");
    service
        .edit(
            EditRequest {
                id: created.id.clone(),
                version: Some(1),
                title: Some("新标题".to_owned()),
                body: Some("新正文".to_owned()),
                tags: None,
                kind: None,
                author: None,
            },
            Some(&batch),
        )
        .await
        .expect("编辑");

    let revert = RevertService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        fixture.env.embedder.clone(),
    );
    revert.revert(&batch).await.expect("撤销");

    let stored = InsightRepo::get(fixture.env.meta.as_ref(), &created.id)
        .await
        .expect("读")
        .expect("存在");
    assert_eq!(stored.title, "原标题", "标题应回到编辑前");
    assert_eq!(stored.body_md, "原正文", "正文应回到编辑前");
}

#[tokio::test]
async fn stats_overview_reports_collections_and_queue() {
    let fixture = fixture().await;
    let stats = StatsService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        fixture.env.embedder.clone(),
        Arc::new(NoopReranker),
        "off",
    );
    let overview = stats.overview().await.expect("概览");
    assert_eq!(overview.collections.len(), 1, "一个 collection");
    assert_eq!(overview.collections[0].name, fixture.collection.name);
    assert!(overview.collections[0].rows >= 2, "至少两个块");
    assert_eq!(overview.totals.projects, 1, "一个项目");
    assert_eq!(overview.embedder.id, fixture.env.embedder.id());
    assert_eq!(overview.drafts_pending, 0, "AI 管家之前恒为 0");
    assert!(
        overview.activity_7d.is_empty(),
        "没有 insight 时活跃度为空:{:?}",
        overview.activity_7d
    );

    // 新建一条 insight(今天)→ 近 7 天活跃度里应有它
    let created = items(&fixture)
        .create(
            CreateRequest {
                collection: Some(fixture.collection.name.clone()),
                project: None,
                global: false,
                title: "活跃度".to_owned(),
                body: "今天新增".to_owned(),
                kind: None,
                tags: Vec::new(),
                related_paths: Vec::new(),
                created_by: "user".to_owned(),
                cwd: None,
            },
            None,
        )
        .await
        .expect("新建");
    let overview = stats.overview().await.expect("概览");
    let today = &overview.activity_7d;
    assert_eq!(today.len(), 1, "只有今天一条:{today:?}");
    assert_eq!(today[0].collection, fixture.collection.name);
    assert_eq!(today[0].insights, 1);
    assert_eq!(today[0].day.len(), 10, "日期应是 YYYY-MM-DD:{today:?}");
    let _ = created;
}

#[tokio::test]
async fn audit_and_batch_lists_are_paginated() {
    let fixture = fixture().await;
    // 造两条审计与一个批次
    AuditRepo::record(
        fixture.env.meta.as_ref(),
        kb_core::model::AuditEntry {
            id: None,
            at: 1_700_000_000_000,
            actor: "user".to_owned(),
            capability: "edit_item".to_owned(),
            args_json: "{}".to_owned(),
            ok: true,
            error: None,
            batch_id: None,
            dry_run: false,
            took_ms: None,
            degraded: None,
        },
    )
    .await
    .expect("写审计");
    let batch = AuditRepo::begin_batch(fixture.env.meta.as_ref(), "user", "批量打标签")
        .await
        .expect("开批次");

    let entries = AuditRepo::list(fixture.env.meta.as_ref(), None, Page::new(10, 0))
        .await
        .expect("列审计");
    assert_eq!(entries.len(), 1);
    let batches = AuditRepo::list_batches(fixture.env.meta.as_ref(), Page::new(10, 0))
        .await
        .expect("列批次");
    assert_eq!(batches.len(), 1);
    assert_eq!(batches[0].id, batch);
}

#[tokio::test]
async fn delete_collection_removes_rows_and_table() {
    let fixture = fixture().await;
    CollectionService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        fixture.env.embedder.clone(),
    )
    .delete(&fixture.collection.name)
    .await
    .expect("删 collection");
    assert!(
        CollectionRepo::get(fixture.env.meta.as_ref(), &fixture.collection.name)
            .await
            .expect("读")
            .is_none(),
        "SQLite 行应删掉"
    );
    assert!(
        fixture
            .env
            .store
            .count(&fixture.collection.active_table, None)
            .await
            .is_err(),
        "物理表应删掉"
    );
    let _ = fixture.project;
}

#[tokio::test]
async fn tokens_can_be_created_listed_and_revoked() {
    let fixture = fixture().await;
    let token = kb_core::model::ApiToken {
        id: "t1".to_owned(),
        name: "ci".to_owned(),
        token_hash: kb_core::token::sha256_hex("kb_secret"),
        scopes: "mcp".to_owned(),
        created_at: 1_700_000_000_000,
        last_used: None,
        revoked_at: None,
    };
    AuthRepo::create_api_token(fixture.env.meta.as_ref(), token.clone())
        .await
        .expect("建令牌");
    let listed = AuthRepo::list_api_tokens(fixture.env.meta.as_ref())
        .await
        .expect("列令牌");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].name, "ci");
    AuthRepo::revoke_api_token(fixture.env.meta.as_ref(), "t1", 1_700_000_001_000)
        .await
        .expect("撤销");
    let listed = AuthRepo::list_api_tokens(fixture.env.meta.as_ref())
        .await
        .expect("列令牌");
    assert!(listed[0].revoked_at.is_some(), "撤销时间应写入");
}

#[tokio::test]
async fn item_statuses_can_be_filtered() {
    let fixture = fixture().await;
    let service = items(&fixture);
    let created = service
        .create(
            CreateRequest {
                collection: Some(fixture.collection.name.clone()),
                project: None,
                global: false,
                title: "临时".to_owned(),
                body: "待废弃".to_owned(),
                kind: None,
                tags: Vec::new(),
                related_paths: Vec::new(),
                created_by: "user".to_owned(),
                cwd: None,
            },
            None,
        )
        .await
        .expect("新建");
    drain(&fixture.env).await;
    // 用 InsightService 改状态:SQLite 与 LanceDB 两边一起改(单独改 SQLite 不会同步检索副本)
    kb_service::InsightService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        fixture.env.embedder.clone(),
    )
    .set_status(&created.id, ItemStatus::Deprecated)
    .await
    .expect("改状态");

    // 默认只看 active
    let active = service
        .list(list_request(&fixture.collection.name))
        .await
        .expect("默认列表");
    assert!(
        !active.items.iter().any(|item| item.id == created.id),
        "deprecated 条目默认不出现"
    );

    // 指定三种状态时出现
    let mut request = list_request(&fixture.collection.name);
    request.statuses = vec![
        ItemStatus::Active,
        ItemStatus::Superseded,
        ItemStatus::Deprecated,
    ];
    let all = service.list(request).await.expect("全部状态");
    assert!(
        all.items.iter().any(|item| item.id == created.id),
        "指定状态后应出现"
    );
}
