//! 验收:批注进入检索、Office → Markdown 副本。
//!
//! 1. 批注锚定到页/单元格,能被检索命中,并带 anchor;
//! 2. docx → md 副本保留标题层级与表格,副本作为独立条目入库,与原件建立 `derived_from` 边;
//! 3. 副本可以再编辑(走 的 `FileEditService`),检索命中副本。

use std::sync::Arc;

use kb_core::model::{Anchor, EdgeRel};
use kb_core::ports::repo::{ChunkRepo, EdgeRepo, IngestRepo, VersionRepo};
use kb_service::IndexService;
use kb_service::annotation::{AddAnnotationRequest, AnnotationService, MarkdownCopyService};
use kb_service::edit::{FileEditService, SaveFileRequest};
use kb_service::index::IndexOptions;
use kb_service::search::{SearchOptions, SearchRequest, SearchService};
use kb_testkit::TestEnv;

const COLLECTION: &str = "_global";

struct Harness {
    env: TestEnv,
    annotations: AnnotationService,
    copies: MarkdownCopyService,
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
        let annotations =
            AnnotationService::new(env.meta.clone(), env.store.clone(), env.embedder.clone());
        let copies = MarkdownCopyService::new(env.meta.clone(), index.clone(), env.paths());
        let edits = FileEditService::new(env.meta.clone(), index, env.paths());
        Self {
            env,
            annotations,
            copies,
            edits,
        }
    }

    /// 放一个 docx 样本(标题 + 段落 + 表格),返回相对路径。
    fn write_docx(&self) -> String {
        let document = r#"<?xml version="1.0"?>
<w:document xmlns:w="w"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>季度报告</w:t></w:r></w:p>
<w:p><w:r><w:t>本季度新增了两个数据源。</w:t></w:r></w:p>
<w:tbl>
  <w:tr><w:tc><w:p><w:r><w:t>项目</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>金额</w:t></w:r></w:p></w:tc></w:tr>
  <w:tr><w:tc><w:p><w:r><w:t>研发</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>42</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>
</w:body></w:document>"#;
        let bytes = kb_extract::zip::build_stored_zip(&[
            ("[Content_Types].xml", b"<Types/>"),
            ("word/document.xml", document.as_bytes()),
        ]);
        let dir = self.env.paths().sources_dir().join("p6.5-09");
        std::fs::create_dir_all(&dir).expect("建目录");
        let path = dir.join("report.docx");
        std::fs::write(&path, bytes).expect("写 docx");
        "report.docx".to_owned()
    }
}

async fn search(harness: &Harness, query: &str) -> Vec<kb_core::model::SearchHit> {
    let service = SearchService::new(
        harness.env.meta.clone(),
        harness.env.store.clone(),
        harness.env.embedder.clone(),
        Arc::new(kb_service::search::NoopReranker),
        SearchOptions::default(),
    );
    service
        .search(SearchRequest {
            query: query.to_owned(),
            collections: vec![COLLECTION.to_owned()],
            k: Some(5),
            explain: false,
            rerank: None,
        })
        .await
        .expect("检索")
        .hits
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn annotations_are_searchable_and_keep_their_anchor() {
    let harness = Harness::new().await;
    let annotation = harness
        .annotations
        .add(AddAnnotationRequest {
            collection: COLLECTION.to_owned(),
            source: "docs/报告.pdf".to_owned(),
            anchor: Some(Anchor::Page { page: 3 }),
            body: "这里的口径和财务不一致,需要复核。".to_owned(),
            author: "alice".to_owned(),
            parent_id: None,
            mentions: Vec::new(),
        })
        .await
        .expect("加批注");
    assert_eq!(annotation.anchor, Some(Anchor::Page { page: 3 }));

    // 检索命中批注,并且带 anchor(能跳回第 3 页)
    let hits = search(&harness, "口径不一致 复核").await;
    let hit = hits
        .iter()
        .find(|hit| hit.id == annotation.id)
        .unwrap_or_else(|| panic!("应命中批注:{hits:?}"));
    assert_eq!(hit.anchor, Some(Anchor::Page { page: 3 }));
    assert!(hit.source.contains("#annotation:"), "{}", hit.source);

    // 列表能查到
    let listed = harness
        .annotations
        .list(COLLECTION, "docs/报告.pdf", 10)
        .await
        .expect("列批注");
    assert_eq!(listed.len(), 1);

    // 删除后检索不到
    harness
        .annotations
        .delete(&annotation.id)
        .await
        .expect("删批注");
    let hits = search(&harness, "口径不一致 复核").await;
    assert!(hits.iter().all(|hit| hit.id != annotation.id), "{hits:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn docx_becomes_a_markdown_copy_linked_to_the_original() {
    let harness = Harness::new().await;
    let path = harness.write_docx();
    let result = harness
        .copies
        .convert(COLLECTION, &path, "test")
        .await
        .expect("转 Markdown 副本");
    assert_eq!(result.path, "report.md");
    assert!(result.chunks > 0, "{result:?}");

    // 副本内容:标题层级、表格、正文都在
    let dir = harness.env.paths().sources_dir().join("p6.5-09");
    let markdown = std::fs::read_to_string(dir.join("report.md")).expect("读副本");
    assert!(markdown.contains("# 季度报告"), "{markdown}");
    assert!(markdown.contains("| 项目 | 金额 |"), "{markdown}");
    assert!(markdown.contains("| 研发 | 42 |"), "{markdown}");
    assert!(markdown.contains("新增了两个数据源"), "{markdown}");

    // 副本是独立条目,并与原件建立 derived_from 边
    let chunks = ChunkRepo::by_path(harness.env.meta.as_ref(), COLLECTION, "report.md")
        .await
        .expect("副本的块");
    assert!(!chunks.is_empty());
    let edges = EdgeRepo::by_dst(harness.env.meta.as_ref(), "path:report.docx")
        .await
        .expect("查边");
    assert!(
        edges.iter().any(|edge| edge.rel == EdgeRel::DerivedFrom),
        "{edges:?}"
    );

    // 副本可再编辑,编辑后检索命中副本
    let edited = format!("{markdown}\n## 补充\n\n副本里加的一段话。\n");
    harness
        .edits
        .save(SaveFileRequest {
            collection: COLLECTION.to_owned(),
            path: "report.md".to_owned(),
            content: edited,
            expected_version: None,
            author: "test".to_owned(),
            tags: Vec::new(),
        })
        .await
        .expect("编辑副本");
    let latest = VersionRepo::latest_version(
        harness.env.meta.as_ref(),
        &FileEditService::item_id(COLLECTION, "report.md"),
    )
    .await
    .expect("版本");
    assert!(latest >= 2, "编辑副本应产生版本:{latest}");
    let hits = search(&harness, "副本里加的一段话").await;
    assert!(
        hits.iter().any(|hit| hit.source == "report.md"),
        "应命中副本:{hits:?}"
    );
}

/// 嵌套目录里的文件:副本要落在原文件旁边,不能把相对路径整个再拼一遍。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn markdown_copy_keeps_the_nested_path() {
    let harness = Harness::new().await;
    let root = harness.env.paths().sources_dir().join("p6.5-09");
    let nested = root.join("docs/sub");
    std::fs::create_dir_all(&nested).expect("建目录");
    std::fs::write(
        nested.join("page.html"),
        "<html><body><h1>子页面</h1><p>嵌套目录里的内容。</p></body></html>",
    )
    .expect("写 HTML");

    let result = harness
        .copies
        .convert(COLLECTION, "docs/sub/page.html", "test")
        .await
        .expect("转 Markdown 副本");
    assert_eq!(
        result.path, "docs/sub/page.md",
        "报告的路径应是 collection 相对路径"
    );
    assert!(
        root.join("docs/sub/page.md").is_file(),
        "副本应写在原文件旁边"
    );
    assert!(
        !root.join("docs/sub/docs").exists(),
        "不应生成 docs/sub/docs/sub/page.md 这种嵌套重复"
    );

    // 已经是 Markdown 的输入不再生成副本(否则会把原件当副本再索引一遍)
    let already = harness
        .copies
        .convert(COLLECTION, "docs/sub/page.md", "test")
        .await;
    assert!(
        matches!(already, Err(kb_core::KbError::InvalidInput(_))),
        "对 .md 输入应报 InvalidInput,实际 {already:?}"
    );
}

/// 操作手册里嵌了系统截图:转出来的副本要带着截图,而不是一句"图片"占位。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn docx_screenshots_are_exported_next_to_the_copy() {
    let harness = Harness::new().await;
    let root = harness.env.paths().sources_dir().join("p6.5-09");
    let nested = root.join("手册");
    std::fs::create_dir_all(&nested).expect("建目录");
    let document = r#"<?xml version="1.0"?>
<w:document xmlns:w="w" xmlns:a="a" xmlns:r="r"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>订单导入</w:t></w:r></w:p>
<w:p><w:r><w:t>第一步:点击导入按钮。</w:t></w:r></w:p>
<w:p><w:r><w:drawing><a:blip r:embed="rId5"/></w:drawing></w:r></w:p>
<w:p><w:r><w:t>第二步:选择文件。</w:t></w:r></w:p>
<w:p><w:r><w:drawing><a:blip r:embed="rId6"/></w:drawing></w:r></w:p>
</w:body></w:document>"#;
    let rels = r#"<Relationships>
<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
<Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image2.png"/>
</Relationships>"#;
    let bytes = kb_extract::zip::build_stored_zip(&[
        ("[Content_Types].xml", b"<Types/>"),
        ("word/document.xml", document.as_bytes()),
        ("word/_rels/document.xml.rels", rels.as_bytes()),
        ("word/media/image1.png", b"\x89PNG-first"),
        ("word/media/image2.png", b"\x89PNG-second"),
    ]);
    std::fs::write(nested.join("操作 手册.docx"), bytes).expect("写 docx");

    let result = harness
        .copies
        .convert(COLLECTION, "手册/操作 手册.docx", "test")
        .await
        .expect("转 Markdown 副本");
    assert_eq!(result.path, "手册/操作 手册.md");
    assert_eq!(result.images, 2);
    assert_eq!(result.exported_images, 2, "{result:?}");

    // 截图写在副本旁边的 `<副本名>.assets/`,正文用相对路径引用(空格转义、中文原样)
    let markdown = std::fs::read_to_string(nested.join("操作 手册.md")).expect("读副本");
    let first = markdown
        .find("![图片1](操作%20手册.assets/image1.png)")
        .unwrap_or_else(|| panic!("{markdown}"));
    let second = markdown
        .find("![图片2](操作%20手册.assets/image2.png)")
        .unwrap_or_else(|| panic!("{markdown}"));
    assert!(first < second, "图片要按原文顺序排");
    assert!(
        markdown.find("第一步").unwrap() < first && first < markdown.find("第二步").unwrap(),
        "截图要紧跟在它所在的步骤后面:{markdown}"
    );
    assert!(!markdown.contains("> 图片:"), "不该再留占位说明:{markdown}");
    let assets = nested.join("操作 手册.assets");
    assert_eq!(
        std::fs::read(assets.join("image1.png")).unwrap(),
        b"\x89PNG-first"
    );
    assert_eq!(
        std::fs::read(assets.join("image2.png")).unwrap(),
        b"\x89PNG-second"
    );

    // 再转一次:覆盖同名文件,不会越攒越多
    harness
        .copies
        .convert(COLLECTION, "手册/操作 手册.docx", "test")
        .await
        .expect("重新转换");
    assert_eq!(std::fs::read_dir(&assets).unwrap().count(), 2);

    // 副本照常作为独立条目入库
    let chunks = ChunkRepo::by_path(harness.env.meta.as_ref(), COLLECTION, "手册/操作 手册.md")
        .await
        .expect("副本的块");
    assert!(!chunks.is_empty());
}

// ---------------------------------------------------------------- 安全审查 S-1:路径穿越

#[tokio::test]
async fn convert_cannot_read_files_outside_the_knowledge_base() {
    let harness = Harness::new().await;
    harness.write_docx();
    let secret = harness.env.paths().home().join("secrets.toml");
    std::fs::write(&secret, "[llm]\napi_key = \"sk-VERY-SECRET-KEY-123456\"\n").unwrap();

    for attack in [
        "../../secrets.toml",
        "../../../secrets.toml",
        secret.to_str().unwrap(),
    ] {
        let err = harness
            .copies
            .convert(COLLECTION, attack, "attacker")
            .await
            .expect_err("穿越路径必须被拒绝");
        assert!(
            matches!(err, kb_core::KbError::InvalidInput(_)),
            "{attack}: {err}"
        );
    }
    // 没有生成副本、也没有被索引
    assert!(!harness.env.paths().home().join("secrets.md").exists());
}

// ---------------------------------------------------------------- .7:回复、已解决、级联删除

fn comment(source: &str, body: &str, author: &str, parent: Option<&str>) -> AddAnnotationRequest {
    AddAnnotationRequest {
        collection: COLLECTION.to_owned(),
        source: source.to_owned(),
        anchor: Some(Anchor::Page { page: 7 }),
        body: body.to_owned(),
        author: author.to_owned(),
        parent_id: parent.map(str::to_owned),
        mentions: Vec::new(),
    }
}

#[tokio::test]
async fn replies_hang_under_a_top_level_comment_and_keep_its_anchor() {
    let harness = Harness::new().await;
    let top = harness
        .annotations
        .add(comment("docs/a.pdf", "顶层评论", "usr_alice", None))
        .await
        .expect("顶层");
    let mut reply = comment("docs/a.pdf", "回复", "usr_bob", Some(&top.id));
    reply.anchor = Some(Anchor::Page { page: 99 }); // 想挂到别的位置:忽略,沿用被回复评论的锚点
    reply.mentions = vec!["usr_alice".into(), "usr_alice".into(), "usr_carol".into()];
    let reply = harness.annotations.add(reply).await.expect("回复");
    assert_eq!(reply.parent_id.as_deref(), Some(top.id.as_str()));
    assert_eq!(reply.anchor, Some(Anchor::Page { page: 7 }));
    assert_eq!(
        reply.mentions,
        ["usr_alice", "usr_carol"],
        "@ 的人去重并排序"
    );

    // 回复不能再被回复(只有一层)
    let err = harness
        .annotations
        .add(comment(
            "docs/a.pdf",
            "回复的回复",
            "usr_carol",
            Some(&reply.id),
        ))
        .await
        .expect_err("只有一层");
    assert!(matches!(err, kb_core::KbError::InvalidInput(_)), "{err}");
    // 回复一条不存在的 / 别的文件上的评论:一律当作不存在
    for bad in ["no-such-id", top.id.as_str()] {
        let source = if bad == top.id {
            "docs/b.pdf"
        } else {
            "docs/a.pdf"
        };
        let err = harness
            .annotations
            .add(comment(source, "x", "usr_bob", Some(bad)))
            .await
            .expect_err("找不到");
        assert!(matches!(err, kb_core::KbError::NotFound(_)), "{bad}: {err}");
    }
    // 列表里两条都在,回复带着 parent_id
    let listed = harness
        .annotations
        .list(COLLECTION, "docs/a.pdf", 50)
        .await
        .unwrap();
    assert_eq!(listed.len(), 2);
    assert!(
        listed
            .iter()
            .any(|a| a.parent_id.as_deref() == Some(top.id.as_str()))
    );
}

#[tokio::test]
async fn only_top_level_comments_can_be_resolved_and_it_can_be_undone() {
    let harness = Harness::new().await;
    let top = harness
        .annotations
        .add(comment("docs/a.pdf", "顶层", "usr_alice", None))
        .await
        .unwrap();
    let reply = harness
        .annotations
        .add(comment("docs/a.pdf", "回复", "usr_bob", Some(&top.id)))
        .await
        .unwrap();
    let resolved = harness
        .annotations
        .resolve(&top.id, "usr_bob", true)
        .await
        .expect("标记已解决");
    assert!(resolved.resolved_at.is_some());
    assert_eq!(resolved.resolved_by.as_deref(), Some("usr_bob"));
    let err = harness
        .annotations
        .resolve(&reply.id, "usr_bob", true)
        .await
        .expect_err("回复不能单独标记");
    assert!(matches!(err, kb_core::KbError::InvalidInput(_)), "{err}");
    let reopened = harness
        .annotations
        .resolve(&top.id, "usr_alice", false)
        .await
        .expect("取消已解决");
    assert!(reopened.resolved_at.is_none() && reopened.resolved_by.is_none());
    assert!(matches!(
        harness.annotations.resolve("nope", "usr_bob", true).await,
        Err(kb_core::KbError::NotFound(_))
    ));
}

#[tokio::test]
async fn deleting_a_comment_deletes_its_replies_too() {
    let harness = Harness::new().await;
    let top = harness
        .annotations
        .add(comment("docs/a.pdf", "顶层", "usr_alice", None))
        .await
        .unwrap();
    for n in 0..2 {
        harness
            .annotations
            .add(comment(
                "docs/a.pdf",
                &format!("回复 {n}"),
                "usr_bob",
                Some(&top.id),
            ))
            .await
            .unwrap();
    }
    let other = harness
        .annotations
        .add(comment("docs/a.pdf", "另一条", "usr_carol", None))
        .await
        .unwrap();
    harness.annotations.delete(&top.id).await.expect("删除");
    let left = harness
        .annotations
        .list(COLLECTION, "docs/a.pdf", 50)
        .await
        .unwrap();
    assert_eq!(left.len(), 1, "只剩另一条顶层评论:{left:?}");
    assert_eq!(left[0].id, other.id);
}

/// 选区批注:评论锚定在选中的一段文字上;回复沿用它;超长的摘录被拒绝(锚点是调用方传的不可信输入)。
#[tokio::test]
async fn quote_anchors_are_stored_inherited_by_replies_and_bounded() {
    let harness = Harness::new().await;
    let quote = Anchor::Quote {
        text: "这一句要讨论".to_owned(),
        prefix: "前文".to_owned(),
        suffix: "后文".to_owned(),
    };
    let mut top = comment("notes/plan.md", "这里的口径不对", "usr_alice", None);
    top.anchor = Some(quote.clone());
    let top = harness.annotations.add(top).await.expect("选区批注");
    assert_eq!(top.anchor, Some(quote.clone()));

    // 列表里原样取回
    let listed = harness
        .annotations
        .list(COLLECTION, "notes/plan.md", 10)
        .await
        .expect("列批注");
    assert_eq!(listed[0].anchor, Some(quote.clone()));

    // 回复沿用被回复评论的摘录
    let mut reply = comment("notes/plan.md", "同意", "usr_bob", Some(&top.id));
    reply.anchor = Some(Anchor::Page { page: 3 });
    let reply = harness.annotations.add(reply).await.expect("回复");
    assert_eq!(reply.anchor, Some(quote));

    // 检索里能搜到它,而且位置说明是摘录的开头
    let hits = search(&harness, "口径不对").await;
    let hit = hits
        .iter()
        .find(|hit| hit.id == top.id)
        .expect("应命中选区批注");
    assert!(hit.source.contains("#annotation:"), "{}", hit.source);

    // 摘录过长 / 为空:拒绝,而且不写任何东西
    for bad in [
        Anchor::Quote {
            text: "字".repeat(kb_core::model::MAX_QUOTE_CHARS + 1),
            prefix: String::new(),
            suffix: String::new(),
        },
        Anchor::Quote {
            text: "   ".to_owned(),
            prefix: String::new(),
            suffix: String::new(),
        },
        Anchor::Quote {
            text: "x".to_owned(),
            prefix: "字".repeat(kb_core::model::MAX_QUOTE_CONTEXT_CHARS + 1),
            suffix: String::new(),
        },
    ] {
        let mut request = comment("notes/plan.md", "不该写进去", "usr_alice", None);
        request.anchor = Some(bad);
        let err = harness.annotations.add(request).await.expect_err("应拒绝");
        assert!(matches!(err, kb_core::KbError::InvalidInput(_)), "{err}");
    }
    let after = harness
        .annotations
        .list(COLLECTION, "notes/plan.md", 10)
        .await
        .expect("列批注");
    assert_eq!(after.len(), 2, "被拒绝的不能留下记录");
}

/// 上传进来的 docx(有解析队列记录):转出的副本和截图也要登记,否则预览 / 编辑 / 读截图按路径都找不到。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn copies_and_screenshots_of_an_uploaded_file_are_registered_for_lookup() {
    let harness = Harness::new().await;
    let root = harness
        .env
        .paths()
        .sources_dir()
        .join("src-up")
        .join("手册");
    std::fs::create_dir_all(&root).expect("建目录");
    let document = r#"<w:document xmlns:w="w" xmlns:a="a" xmlns:r="r"><w:body>
<w:p><w:r><w:t>第一步</w:t></w:r></w:p>
<w:p><w:r><w:drawing><a:blip r:embed="rId5"/></w:drawing></w:r></w:p>
</w:body></w:document>"#;
    let rels = r#"<Relationships><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>"#;
    let bytes = kb_extract::zip::build_stored_zip(&[
        ("word/document.xml", document.as_bytes()),
        ("word/_rels/document.xml.rels", rels.as_bytes()),
        ("word/media/image1.png", b"\x89PNG-shot"),
    ]);
    let original = root.join("上传的手册.docx");
    std::fs::write(&original, bytes).expect("写 docx");
    let now = 1_700_000_000_000;
    IngestRepo::create(
        harness.env.meta.as_ref(),
        kb_core::model::IngestFile {
            id: "ing-1".to_owned(),
            batch_id: None,
            source_id: None,
            upload_id: None,
            collection: COLLECTION.to_owned(),
            rel_path: "手册/上传的手册.docx".to_owned(),
            abs_path: original.display().to_string(),
            size: 1,
            sha256: None,
            state: kb_core::model::IngestState::Done,
            error: None,
            chunks: 1,
            vectors: 1,
            extract_meta: None,
            derived_from: None,
            elapsed_ms: None,
            created_at: now,
            updated_at: now,
        },
    )
    .await
    .expect("登记原件");

    let result = harness
        .copies
        .convert(COLLECTION, "手册/上传的手册.docx", "test")
        .await
        .expect("转副本");
    assert_eq!(result.exported_images, 1);

    let lookup = |rel: &'static str| {
        let meta = harness.env.meta.clone();
        async move {
            IngestRepo::get_by_path(meta.as_ref(), COLLECTION, rel)
                .await
                .expect("查记录")
        }
    };
    let copy = lookup("手册/上传的手册.md").await.expect("副本应登记");
    assert_eq!(copy.derived_from.as_deref(), Some("手册/上传的手册.docx"));
    assert_eq!(copy.state, kb_core::model::IngestState::Done);
    assert!(std::path::Path::new(&copy.abs_path).is_file());
    assert!(copy.chunks > 0);
    let shot = lookup("手册/上传的手册.assets/image1.png")
        .await
        .expect("截图应登记");
    assert_eq!(
        std::fs::read(&shot.abs_path).expect("读截图"),
        b"\x89PNG-shot"
    );
    assert_eq!(shot.derived_from.as_deref(), Some("手册/上传的手册.docx"));

    // 再转一次:不会因为唯一键冲突失败,也不会多出记录
    harness
        .copies
        .convert(COLLECTION, "手册/上传的手册.docx", "test")
        .await
        .expect("重新转换");
    assert_eq!(
        lookup("手册/上传的手册.md").await.expect("仍在").id,
        copy.id
    );
}
