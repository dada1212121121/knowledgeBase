//! 验收:网页来源的 AI 规范化(设计规范)。
//!
//! 站点用本地起的极简 HTTP 服务,模型用 `MockChatModel`(能数调用次数、看请求),
//! 后台任务用真实的 `Worker` + 解析任务跑完,不碰外网、不调云端模型。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use kb_core::config::{UploadConfig, WebExtractConfig};
use kb_core::model::{ChatMessage, ChatResponse, IngestState, Source};
use kb_core::ports::ChatModel;
use kb_core::ports::repo::{ChunkRepo, EdgeRepo, IngestRepo, MetaStore, SourceRepo};
use kb_llm::MockChatModel;
use kb_service::index::IndexOptions;
use kb_service::jobs::{JobQueue, JobRouter, Worker};
use kb_service::llm_gate::{GateConfig, LlmGate};
use kb_service::upload::unpack::UnpackLimits;
use kb_service::web_extract::{
    self, PageRecord, WebExtractDeps, WebExtractJobHandler, normalize, prompt,
};
use kb_service::{
    AddSourceRequest, IndexService, IngestJobHandler, SourceService, UpdateSourceRequest,
};
use kb_testkit::TestEnv;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::watch;

const COLLECTION: &str = "_global";
/// 只出现在模型回复里的词:用它检索,命中的只能是规范化结果。
const MARKER: &str = "zephyrquokka";

// ---------------- 本地站点 ----------------

type Site = Arc<Mutex<Vec<(String, String)>>>;

async fn serve_site(pages: Vec<(&str, String)>) -> (String, Site) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("绑定端口");
    let port = listener.local_addr().expect("地址").port();
    let site: Site = Arc::new(Mutex::new(
        pages
            .into_iter()
            .map(|(path, body)| (path.to_owned(), body))
            .collect(),
    ));
    let pages = site.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            let pages = pages.clone();
            tokio::spawn(async move {
                let mut buffer = vec![0u8; 4096];
                let read = socket.read(&mut buffer).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buffer[..read]).into_owned();
                let path = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("/")
                    .to_owned();
                let body = pages.lock().ok().and_then(|pages| {
                    pages
                        .iter()
                        .find(|(candidate, _)| *candidate == path)
                        .map(|(_, body)| body.clone())
                });
                let response = match body {
                    Some(body) => format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    ),
                    None => {
                        "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                            .to_owned()
                    }
                };
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.flush().await;
            });
        }
    });
    (format!("http://127.0.0.1:{port}"), site)
}

fn set_page(site: &Site, path: &str, body: Option<String>) {
    if let Ok(mut pages) = site.lock() {
        pages.retain(|(candidate, _)| candidate != path);
        if let Some(body) = body {
            pages.push((path.to_owned(), body));
        }
    }
}

fn two_pages() -> Vec<(&'static str, String)> {
    vec![
        ("/robots.txt", String::new()),
        (
            "/index.html",
            "<html><head><title>文档首页</title></head><body><h1>安装指南</h1>\
             <p>先安装工具链,再运行构建。</p><a href=\"/a.html\">配置说明</a></body></html>"
                .to_owned(),
        ),
        (
            "/a.html",
            "<html><head><title>配置</title></head><body><h1>配置</h1>\
             <p>配置文件放在主目录下。</p></body></html>"
                .to_owned(),
        ),
    ]
}

// ---------------- 假模型回复 ----------------

fn response(text: &str) -> ChatResponse {
    ChatResponse {
        message: ChatMessage {
            role: "assistant".to_owned(),
            content: Some(text.to_owned()),
            tool_calls: Vec::new(),
            tool_call_id: None,
        },
        input_tokens: 100,
        output_tokens: 50,
        finish_reason: "stop".to_owned(),
    }
}

fn normalized(summary: &str, key_points: &[&str]) -> String {
    json!({
        "title": "规范化标题",
        "page_type": "doc",
        "language": "zh",
        "summary": summary,
        "key_points": key_points,
        "sections": [{"heading": "安装", "level": 2, "content": "先安装工具链。"}],
        "facts": [{"name": "最低版本", "value": "1.91", "unit": null}],
        "tags": ["安装"],
        "custom": {}
    })
    .to_string()
}

fn good_reply() -> String {
    normalized(&format!("这页讲安装步骤 {MARKER}"), &["先装工具链"])
}

// ---------------- 测试替身:守护进程侧的依赖 ----------------

struct TestDeps {
    meta: Arc<dyn MetaStore>,
    model: Arc<MockChatModel>,
    ai_enabled: AtomicBool,
    gate: Mutex<GateConfig>,
    settings: Mutex<WebExtractConfig>,
}

impl WebExtractDeps for TestDeps {
    fn settings(&self) -> WebExtractConfig {
        self.settings.lock().map(|s| s.clone()).unwrap_or_default()
    }

    fn ai_enabled(&self) -> bool {
        self.ai_enabled.load(Ordering::SeqCst)
    }

    fn gate(&self, _payer: Option<&str>) -> LlmGate {
        let config = self.gate.lock().map(|g| g.clone()).unwrap_or_default();
        LlmGate::new(self.meta.clone(), config)
    }

    fn model(&self) -> kb_core::Result<Option<Arc<dyn ChatModel>>> {
        let model: Arc<dyn ChatModel> = self.model.clone();
        Ok(Some(model))
    }

    fn prompt_override(&self) -> Option<String> {
        None
    }
}

struct Harness {
    env: TestEnv,
    sources: SourceService,
    deps: Arc<TestDeps>,
    worker: Worker,
    _shutdown: watch::Sender<bool>,
}

impl Harness {
    async fn new(model: MockChatModel) -> Self {
        let env = TestEnv::new().await;
        kb_service::CollectionService::new(
            env.meta.clone(),
            env.store.clone(),
            env.embedder.clone(),
        )
        .ensure_global()
        .await
        .expect("建 _global");
        let config = UploadConfig::default();
        let paths = env.paths();
        let index = Arc::new(IndexService::new(
            env.meta.clone(),
            env.store.clone(),
            env.embedder.clone(),
            env.chunker.clone(),
            env.scanner.clone(),
            IndexOptions::default(),
        ));
        let ingest = IngestJobHandler::new(
            index,
            env.meta.clone(),
            paths.clone(),
            UnpackLimits {
                max_ratio: 10,
                max_depth: 3,
                max_files: 100,
                max_bytes: config.max_file_mb * 1024 * 1024,
                max_total_bytes: 0,
            },
            10,
            Arc::new(kb_service::ProgressTracker::new(
                env.meta.clone(),
                "cpu-int8",
            )),
        );
        let deps = Arc::new(TestDeps {
            meta: env.meta.clone(),
            model: Arc::new(model),
            ai_enabled: AtomicBool::new(true),
            gate: Mutex::new(GateConfig::default()),
            settings: Mutex::new(WebExtractConfig::default()),
        });
        let mut router = JobRouter::new();
        router.register("ingest", Arc::new(ingest));
        router.register(
            web_extract::JOB_KIND,
            Arc::new(WebExtractJobHandler::new(
                env.meta.clone(),
                paths.clone(),
                deps.clone(),
            )),
        );
        let (tx, rx) = watch::channel(false);
        let worker = Worker::new(
            Arc::new(JobQueue::new(env.meta.clone())),
            Arc::new(router),
            rx,
        );
        let sources = SourceService::new(
            env.meta.clone(),
            env.store.clone(),
            env.scanner.clone(),
            paths,
            config,
        )
        // 测试站点在 127.0.0.1:默认挡内网地址,这里明确打开
        .with_allow_private_web(true);
        Self {
            env,
            sources,
            deps,
            worker,
            _shutdown: tx,
        }
    }

    async fn add_web(&self, url: &str, depth: u32, collection: &str) -> Source {
        self.sources
            .add(AddSourceRequest {
                kind: Some("web".to_owned()),
                name: Some(format!("站点 {url}")),
                uri: Some(url.to_owned()),
                collection: Some(collection.to_owned()),
                depth: Some(depth),
                ai_extract: Some(true),
                ..AddSourceRequest::default()
            })
            .await
            .expect("添加网页数据源")
    }

    /// 同步一次并把后台任务(原文解析 → AI 规范化 → 结果解析)全部跑完。
    async fn sync_and_run(&self, source_id: &str) -> kb_service::SyncOutcome {
        let outcome = self.sources.sync("test", source_id).await.expect("同步");
        self.worker.run_until_idle().await.expect("跑后台任务");
        outcome
    }

    async fn source(&self, id: &str) -> Source {
        SourceRepo::get(self.env.meta.as_ref(), id)
            .await
            .expect("读数据源")
            .expect("数据源存在")
    }

    fn calls(&self) -> usize {
        self.deps.model.calls()
    }

    fn ai_md(&self, source_id: &str, rel: &str) -> std::path::PathBuf {
        web_extract::output_path(&self.env.paths(), source_id, rel)
    }

    fn record(&self, source_id: &str, rel: &str) -> PageRecord {
        let path = web_extract::record_path(&self.env.paths(), source_id, rel);
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|err| panic!("读 {} 失败:{err}", path.display()));
        serde_json::from_str(&text).expect("留档是合法 JSON")
    }

    async fn search_sources(&self, query: &str, collection: &str) -> Vec<String> {
        let search = kb_service::SearchService::new(
            self.env.meta.clone(),
            self.env.store.clone(),
            self.env.embedder.clone(),
            Arc::new(kb_service::search::NoopReranker),
            kb_service::SearchOptions::default(),
        );
        search
            .search(kb_service::SearchRequest {
                query: query.to_owned(),
                collections: vec![collection.to_owned()],
                k: Some(10),
                explain: false,
                rerank: None,
            })
            .await
            .expect("检索")
            .hits
            .into_iter()
            .map(|hit| hit.source)
            .collect()
    }
}

fn host_of(base: &str) -> String {
    base.trim_start_matches("http://").replace(':', "_")
}

// ---------------- 网页正文规范化 ----------------

/// 两页站点同步后两份规范化结果落盘、入库、能按模型回复里的词检索到;
/// 请求不带工具、要求 JSON、正文在分隔块里、没写提取要求时写“自动判断”。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn normalizes_each_page_and_indexes_the_result() {
    let (base, _site) = serve_site(two_pages()).await;
    let harness = Harness::new(MockChatModel::reply(good_reply())).await;
    let source = harness
        .add_web(&format!("{base}/index.html"), 2, COLLECTION)
        .await;
    let outcome = harness.sync_and_run(&source.id).await;
    assert!(
        outcome.ai_job_id.is_some(),
        "打开了 AI 规范化就该投任务:{outcome:?}"
    );
    assert_eq!(harness.calls(), 2, "两页各调一次");

    let host = host_of(&base);
    for page in ["index.html", "a.html"] {
        let rel = format!("{host}/{page}");
        let markdown = std::fs::read_to_string(harness.ai_md(&source.id, &rel)).expect("结果落盘");
        assert!(markdown.contains(MARKER), "{markdown}");
        assert!(markdown.contains("由 AI 规范化"), "{markdown}");
        let ai_rel = web_extract::ai_rel_path(&rel);
        let row = IngestRepo::get_by_path(harness.env.meta.as_ref(), COLLECTION, &ai_rel)
            .await
            .expect("查队列")
            .expect("规范化结果进了解析队列");
        assert_eq!(row.state, IngestState::Done, "{row:?}");
        assert!(row.chunks > 0, "{row:?}");
        assert_eq!(row.derived_from.as_deref(), Some(rel.as_str()));
        // 派生边:规范化结果的块 → 原文页面
        let chunks = ChunkRepo::by_path(harness.env.meta.as_ref(), COLLECTION, &ai_rel)
            .await
            .expect("块");
        let edges = EdgeRepo::by_dst(harness.env.meta.as_ref(), &format!("path:{rel}"))
            .await
            .expect("边");
        assert!(
            edges
                .iter()
                .any(|edge| chunks.iter().any(|chunk| chunk.id == edge.src_id)),
            "应有一条 derived_from 边指向原文 {rel}:{edges:?}"
        );
        // 原文照常入库
        let raw = IngestRepo::get_by_path(harness.env.meta.as_ref(), COLLECTION, &rel)
            .await
            .expect("查原文")
            .expect("原文入库");
        assert_eq!(raw.state, IngestState::Done);
    }

    // 检索:模型回复里独有的词命中规范化结果;按 `ai-extract` 标签过滤只剩规范化结果
    let hits = harness.search_sources(MARKER, COLLECTION).await;
    assert!(
        hits.iter().any(|hit| hit.ends_with(web_extract::AI_SUFFIX)),
        "{hits:?}"
    );
    let tagged = harness
        .search_sources(&format!("tag:{} {MARKER}", web_extract::AI_TAG), COLLECTION)
        .await;
    assert!(!tagged.is_empty());
    assert!(
        tagged
            .iter()
            .all(|hit| hit.ends_with(web_extract::AI_SUFFIX)),
        "ai-extract 标签只在规范化结果上:{tagged:?}"
    );

    // 请求
    for request in harness.deps.model.requests() {
        assert_eq!(request.tools, 0, "规范化不带任何工具");
        assert!(request.json_output);
        let user = request.last_user.unwrap_or_default();
        assert!(user.contains(prompt::AUTO_REQUIREMENT), "{user}");
        let begin = user.find(prompt::BODY_BEGIN).expect("有开始标记");
        let end = user.find(prompt::BODY_END).expect("有结束标记");
        let body = user
            .find("安装指南")
            .or_else(|| user.find("配置文件放在主目录"));
        assert!(
            body.is_some_and(|at| begin < at && at < end),
            "正文应在分隔块里:{user}"
        );
    }

    let status = harness
        .source(&source.id)
        .await
        .ai_status
        .expect("有整理情况");
    assert_eq!((status.done, status.pending, status.failed), (2, 0, 0));
    assert_eq!(status.note, None);
}

/// 内容不变不调模型;改一页只多一次;改提取要求两页都重新整理,要求原文进请求。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn only_changed_pages_or_a_new_requirement_cost_calls() {
    let (base, site) = serve_site(two_pages()).await;
    let harness = Harness::new(MockChatModel::reply(good_reply())).await;
    let source = harness
        .add_web(&format!("{base}/index.html"), 2, COLLECTION)
        .await;
    harness.sync_and_run(&source.id).await;
    assert_eq!(harness.calls(), 2);

    harness.sync_and_run(&source.id).await;
    assert_eq!(harness.calls(), 2, "内容没变不应再调模型");
    let status = harness
        .source(&source.id)
        .await
        .ai_status
        .expect("整理情况");
    assert_eq!(status.done, 2);

    set_page(
        &site,
        "/a.html",
        Some("<html><body><h1>配置</h1><p>配置文件改放在 /etc 下。</p></body></html>".to_owned()),
    );
    harness.sync_and_run(&source.id).await;
    assert_eq!(harness.calls(), 3, "只有变了的那一页重新整理");

    harness
        .sources
        .update(UpdateSourceRequest {
            id: source.id.clone(),
            extract_prompt: Some("只要安装步骤和版本要求".to_owned()),
            ..UpdateSourceRequest::default()
        })
        .await
        .expect("改提取要求");
    harness.sync_and_run(&source.id).await;
    assert_eq!(harness.calls(), 5, "提取要求变了,两页都按新要求重新整理");
    let requests = harness.deps.model.requests();
    for request in &requests[3..] {
        let user = request.last_user.clone().unwrap_or_default();
        assert!(user.contains("只要安装步骤和版本要求"), "{user}");
        assert!(!user.contains(prompt::AUTO_REQUIREMENT), "{user}");
    }
}

/// 项目没开外发 → 0 次调用,原文照常入库,数据源上有暂停提示;AI 总开关关了一样。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn gate_refusal_pauses_without_calling_the_model() {
    let (base, _site) = serve_site(two_pages()).await;
    let harness = Harness::new(MockChatModel::reply(good_reply())).await;
    let project_dir = tempfile::tempdir().expect("项目目录");
    std::fs::write(project_dir.path().join("README.md"), "# demo\n").expect("写文件");
    kb_service::ProjectService::new(
        harness.env.meta.clone(),
        harness.env.store.clone(),
        harness.env.embedder.clone(),
    )
    .add(project_dir.path(), Some("demo"))
    .await
    .expect("加项目");
    // 新项目默认 allow_cloud_llm = false
    let source = harness
        .add_web(&format!("{base}/index.html"), 2, "proj_demo")
        .await;
    harness.sync_and_run(&source.id).await;
    assert_eq!(harness.calls(), 0, "项目没开外发,一次都不能调");
    let host = host_of(&base);
    let raw = IngestRepo::get_by_path(
        harness.env.meta.as_ref(),
        "proj_demo",
        &format!("{host}/index.html"),
    )
    .await
    .expect("查原文")
    .expect("原文照常入库");
    assert_eq!(raw.state, IngestState::Done);
    let status = harness
        .source(&source.id)
        .await
        .ai_status
        .expect("整理情况");
    assert_eq!(status.pending, 2, "{status:?}");
    assert!(
        status
            .note
            .as_deref()
            .is_some_and(|note| note.contains("allow_cloud_llm")),
        "{status:?}"
    );

    // AI 总开关关掉:同样不调、留提示
    harness.deps.ai_enabled.store(false, Ordering::SeqCst);
    let other = harness
        .add_web(&format!("{base}/a.html"), 1, COLLECTION)
        .await;
    harness.sync_and_run(&other.id).await;
    assert_eq!(harness.calls(), 0);
    let status = harness.source(&other.id).await.ai_status.expect("整理情况");
    assert_eq!(status.pending, 1);
    assert!(
        status
            .note
            .as_deref()
            .is_some_and(|note| note.contains("AI 功能")),
        "{status:?}"
    );
    assert!(!harness.ai_md(&other.id, &format!("{host}/a.html")).exists());
}

/// 每小时只许调 1 次 → 三页只整理 1 页,其余留到下次;额度恢复后再同步补齐。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn hourly_cap_leaves_the_rest_for_the_next_sync() {
    let mut pages = two_pages();
    pages[1].1 = "<html><body><h1>首页</h1><p>首页正文。</p>\
                  <a href=\"/a.html\">A</a><a href=\"/b.html\">B</a></body></html>"
        .to_owned();
    pages.push((
        "/b.html",
        "<html><body><h1>B</h1><p>页面 B 的正文。</p></body></html>".to_owned(),
    ));
    let (base, _site) = serve_site(pages).await;
    let harness = Harness::new(MockChatModel::reply(good_reply())).await;
    if let Ok(mut gate) = harness.deps.gate.lock() {
        gate.max_calls_per_hour = 1;
    }
    let source = harness
        .add_web(&format!("{base}/index.html"), 2, COLLECTION)
        .await;
    harness.sync_and_run(&source.id).await;
    assert_eq!(harness.calls(), 1);
    let status = harness
        .source(&source.id)
        .await
        .ai_status
        .expect("整理情况");
    assert_eq!((status.done, status.pending), (1, 2), "{status:?}");
    assert!(
        status
            .note
            .as_deref()
            .is_some_and(|note| note.contains("暂停") && note.contains("一小时")),
        "{status:?}"
    );

    // 额度恢复(这里用改上限模拟“过了一小时”),下次同步把剩下的补齐
    if let Ok(mut gate) = harness.deps.gate.lock() {
        gate.max_calls_per_hour = 0;
    }
    harness.sync_and_run(&source.id).await;
    assert_eq!(harness.calls(), 3, "只补剩下的两页");
    let host = host_of(&base);
    for page in ["index.html", "a.html", "b.html"] {
        assert!(
            harness
                .ai_md(&source.id, &format!("{host}/{page}"))
                .is_file(),
            "{page}"
        );
    }
    let status = harness
        .source(&source.id)
        .await
        .ai_status
        .expect("整理情况");
    assert_eq!((status.done, status.pending), (3, 0));
}

/// 先非法 JSON 再合法 → 重试成功;连续两次非法 → 这一页跳过,其它页照常。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn invalid_json_is_retried_once_then_the_page_is_skipped() {
    let (base, _site) = serve_site(two_pages()).await;
    let host = host_of(&base);

    // 重试成功:a(坏 → 好)、index(好)
    let harness = Harness::new(MockChatModel::script(vec![
        response("这不是 JSON"),
        response(&good_reply()),
    ]))
    .await;
    let source = harness
        .add_web(&format!("{base}/index.html"), 2, COLLECTION)
        .await;
    harness.sync_and_run(&source.id).await;
    assert_eq!(harness.calls(), 3);
    let status = harness
        .source(&source.id)
        .await
        .ai_status
        .expect("整理情况");
    assert_eq!((status.done, status.failed), (2, 0), "{status:?}");

    // 两次都坏:a 跳过,index 照常
    let harness = Harness::new(MockChatModel::script(vec![
        response("[1, 2]"),
        response("{坏"),
        response(&good_reply()),
    ]))
    .await;
    let source = harness
        .add_web(&format!("{base}/index.html"), 2, COLLECTION)
        .await;
    harness.sync_and_run(&source.id).await;
    assert_eq!(harness.calls(), 3);
    let status = harness
        .source(&source.id)
        .await
        .ai_status
        .expect("整理情况");
    assert_eq!((status.done, status.failed), (1, 1), "{status:?}");
    assert!(
        status
            .note
            .as_deref()
            .is_some_and(|note| note.contains("1 页整理失败")),
        "{status:?}"
    );
    assert!(
        !harness
            .ai_md(&source.id, &format!("{host}/a.html"))
            .exists()
    );
    assert!(
        harness
            .ai_md(&source.id, &format!("{host}/index.html"))
            .is_file()
    );
}

/// 模型编的链接被过滤,超长字段被截断。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn invented_links_and_oversized_fields_are_cleaned() {
    let (base, _site) = serve_site(two_pages()).await;
    let many: Vec<String> = (0..normalize::MAX_LIST_ITEMS + 30)
        .map(|i| format!("要点 {i}"))
        .collect();
    let reply = json!({
        "title": "首页",
        "summary": "长".repeat(normalize::MAX_SUMMARY_CHARS * 2),
        "key_points": many,
        "links": [
            {"text": "配置", "url": format!("{base}/a.html")},
            {"text": "钓鱼", "url": "https://evil.example/login"},
        ],
    })
    .to_string();
    let harness = Harness::new(MockChatModel::reply(reply)).await;
    let source = harness
        .add_web(&format!("{base}/index.html"), 1, COLLECTION)
        .await;
    harness.sync_and_run(&source.id).await;
    let rel = format!("{}/index.html", host_of(&base));
    let record = harness.record(&source.id, &rel);
    assert_eq!(
        record.result.summary.chars().count(),
        normalize::MAX_SUMMARY_CHARS
    );
    assert_eq!(record.result.key_points.len(), normalize::MAX_LIST_ITEMS);
    let urls: Vec<&str> = record
        .result
        .links
        .iter()
        .map(|link| link.url.as_str())
        .collect();
    assert_eq!(urls, vec![format!("{base}/a.html").as_str()]);
    let markdown = std::fs::read_to_string(harness.ai_md(&source.id, &rel)).expect("结果");
    assert!(!markdown.contains("evil.example"), "{markdown}");
}

/// 超长页面按段调用(≤ max_parts),结果按设计规范合并,截断有提示。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn long_pages_are_split_and_merged() {
    let paragraphs: String = (0..5)
        .map(|i| format!("<p>{}</p>", format!("第{i}段").repeat(300)))
        .collect();
    let (base, _site) = serve_site(vec![
        ("/robots.txt", String::new()),
        (
            "/index.html",
            format!("<html><head><title>长文</title></head><body>{paragraphs}</body></html>"),
        ),
    ])
    .await;
    let harness = Harness::new(MockChatModel::script(vec![
        response(&normalized("第一段的摘要", &["甲"])),
        response(&normalized("第二段的摘要", &["乙", "甲"])),
    ]))
    .await;
    if let Ok(mut settings) = harness.deps.settings.lock() {
        settings.max_input_chars = 2_000;
        settings.max_parts = 2;
    }
    let source = harness
        .add_web(&format!("{base}/index.html"), 1, COLLECTION)
        .await;
    harness.sync_and_run(&source.id).await;
    assert_eq!(
        harness.calls(),
        2,
        "5 段正文 × 每段约 900 字,2000 字一段 → 3 段,只送前 2 段"
    );
    let requests = harness.deps.model.requests();
    assert!(
        requests[0]
            .last_user
            .as_deref()
            .is_some_and(|u| u.contains("第 1/2 段"))
    );
    assert!(
        requests[1]
            .last_user
            .as_deref()
            .is_some_and(|u| u.contains("第 2/2 段"))
    );
    let rel = format!("{}/index.html", host_of(&base));
    let record = harness.record(&source.id, &rel);
    assert_eq!(record.parts, 2);
    assert!(record.result.truncated);
    assert_eq!(record.result.summary, "第一段的摘要");
    assert_eq!(record.result.key_points, vec!["甲", "乙"]);
    let markdown = std::fs::read_to_string(harness.ai_md(&source.id, &rel)).expect("结果");
    assert!(markdown.contains("只整理了前 2 段"), "{markdown}");
}

/// 页面从站点上删掉后再同步 → 原文、规范化结果、留档都清掉,检索不到。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pages_removed_from_the_site_are_cleaned_up() {
    let (base, site) = serve_site(two_pages()).await;
    let harness = Harness::new(MockChatModel::reply(good_reply())).await;
    let source = harness
        .add_web(&format!("{base}/index.html"), 2, COLLECTION)
        .await;
    harness.sync_and_run(&source.id).await;
    let host = host_of(&base);
    let page = format!("{host}/a.html");
    let ai_rel = web_extract::ai_rel_path(&page);
    let tagged = format!("tag:{} {MARKER}", web_extract::AI_TAG);
    assert!(
        harness
            .search_sources(&tagged, COLLECTION)
            .await
            .contains(&ai_rel)
    );

    // 站点删掉 a.html,首页也不再链接它
    set_page(&site, "/a.html", None);
    set_page(
        &site,
        "/index.html",
        Some("<html><body><h1>安装指南</h1><p>只剩首页了。</p></body></html>".to_owned()),
    );
    let outcome = harness.sync_and_run(&source.id).await;
    assert_eq!(outcome.removed, 1, "{outcome:?}");
    for rel in [&page, &ai_rel] {
        assert!(
            IngestRepo::get_by_path(harness.env.meta.as_ref(), COLLECTION, rel)
                .await
                .expect("查队列")
                .is_none(),
            "{rel} 的队列行应被删掉"
        );
    }
    assert!(
        !harness
            .env
            .paths()
            .source_dir(&source.id)
            .join(&page)
            .exists()
    );
    assert!(!harness.ai_md(&source.id, &page).exists());
    assert!(!web_extract::record_path(&harness.env.paths(), &source.id, &page).exists());
    let hits = harness.search_sources(&tagged, COLLECTION).await;
    assert!(!hits.contains(&ai_rel), "删掉的页面不该再被检索到:{hits:?}");
    assert!(
        hits.contains(&web_extract::ai_rel_path(&format!("{host}/index.html"))),
        "{hits:?}"
    );
}

/// 服务层部分;迁移本身见 kb-meta 的 `existing_sources_get_ai_extract_off`。
/// 开关默认值、权限、提取要求校验、只有网页来源存这两项。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ai_fields_follow_defaults_permissions_and_limits() {
    let (base, _site) = serve_site(two_pages()).await;
    let harness = Harness::new(MockChatModel::reply(good_reply())).await;
    let web = |name: &str, ai: Option<bool>, prompt: Option<String>| AddSourceRequest {
        kind: Some("web".to_owned()),
        name: Some(name.to_owned()),
        uri: Some(format!("{base}/index.html")),
        collection: Some(COLLECTION.to_owned()),
        ai_extract: ai,
        extract_prompt: prompt,
        ..AddSourceRequest::default()
    };
    // 默认取 `[web_extract] enabled_by_default`(默认 true)
    let on = harness
        .sources
        .add(web("默认", None, None))
        .await
        .expect("加");
    assert!(on.ai_extract);
    let service = |permitted: bool, default: bool| {
        SourceService::new(
            harness.env.meta.clone(),
            harness.env.store.clone(),
            harness.env.scanner.clone(),
            harness.env.paths(),
            UploadConfig::default(),
        )
        .with_allow_private_web(true)
        .with_ai_extract_default(default)
        .with_ai_permitted(permitted)
    };
    let off = service(true, false)
        .add(web("默认关", None, None))
        .await
        .expect("加");
    assert!(!off.ai_extract);
    // 没有功能权限:默认关,显式打开被拒
    let denied = service(false, true);
    assert!(
        !denied
            .add(web("无权限", None, None))
            .await
            .expect("加")
            .ai_extract
    );
    let err = denied
        .add(web("无权限打开", Some(true), None))
        .await
        .expect_err("没有权限不能打开");
    assert!(matches!(err, kb_core::KbError::Forbidden(_)), "{err}");
    // 没有权限的人同步:原文照常,不投规范化任务,留一句说明
    let outcome = denied.sync("test", &on.id).await.expect("同步");
    assert!(outcome.ai_job_id.is_none());
    let note = harness.source(&on.id).await.ai_status.and_then(|s| s.note);
    assert!(note.is_some_and(|note| note.contains("功能权限")));
    // 提取要求:超长与控制字符被拒,首尾空白去掉并持久化
    let err = harness
        .sources
        .add(web("太长", Some(true), Some("要".repeat(2_001))))
        .await
        .expect_err("超长");
    assert!(matches!(err, kb_core::KbError::InvalidInput(_)), "{err}");
    assert!(
        harness
            .sources
            .add(web("控制字符", Some(true), Some("价格\u{7}".to_owned())))
            .await
            .is_err()
    );
    let with_prompt = harness
        .sources
        .add(web(
            "有要求",
            Some(true),
            Some("  只要价格\n和规格  ".to_owned()),
        ))
        .await
        .expect("加");
    assert_eq!(
        harness.source(&with_prompt.id).await.extract_prompt,
        "只要价格\n和规格"
    );
    // 改:关掉、清空要求
    let updated = harness
        .sources
        .update(UpdateSourceRequest {
            id: with_prompt.id.clone(),
            ai_extract: Some(false),
            extract_prompt: Some(String::new()),
            ..UpdateSourceRequest::default()
        })
        .await
        .expect("改");
    assert!(!updated.ai_extract);
    assert_eq!(harness.source(&with_prompt.id).await.extract_prompt, "");
    // 非网页来源:传了也不存
    let note_source = harness
        .sources
        .add(AddSourceRequest {
            kind: Some("note".to_owned()),
            name: Some("笔记".to_owned()),
            uri: Some("# 笔记\n".to_owned()),
            collection: Some(COLLECTION.to_owned()),
            ai_extract: Some(true),
            extract_prompt: Some("不该存".to_owned()),
            ..AddSourceRequest::default()
        })
        .await
        .expect("加笔记");
    let stored = harness.source(&note_source.id).await;
    assert!(!stored.ai_extract);
    assert_eq!(stored.extract_prompt, "");
    // 关掉的来源同步不投任务(用前面同步过的那个来源:同一集合里两个来源抓同一站点会路径冲突,是既有限制)
    harness
        .sources
        .update(UpdateSourceRequest {
            id: on.id.clone(),
            ai_extract: Some(false),
            ..UpdateSourceRequest::default()
        })
        .await
        .expect("关掉");
    let outcome = harness.sources.sync("test", &on.id).await.expect("同步");
    assert!(outcome.ai_job_id.is_none());
}

/// 移除网页来源:规范化结果目录与抓取清单一起清掉。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn removing_a_source_removes_its_ai_outputs() {
    let (base, _site) = serve_site(two_pages()).await;
    let harness = Harness::new(MockChatModel::reply(good_reply())).await;
    let source = harness
        .add_web(&format!("{base}/index.html"), 2, COLLECTION)
        .await;
    harness.sync_and_run(&source.id).await;
    let ai_dir = web_extract::ai_dir(&harness.env.paths(), &source.id);
    assert!(ai_dir.is_dir());
    let removed = harness.sources.remove(&source.id).await.expect("移除");
    assert_eq!(removed.files, 4, "两页原文 + 两份规范化结果");
    assert!(!ai_dir.exists());
    assert!(!web_extract::manifest_path(&harness.env.paths(), &source.id).exists());
    let hits = harness
        .search_sources(&format!("tag:{} {MARKER}", web_extract::AI_TAG), COLLECTION)
        .await;
    assert!(hits.is_empty(), "{hits:?}");
}
