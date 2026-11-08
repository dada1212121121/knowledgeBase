//! 验收:网页数据源抓取(深度、同域白名单、robots.txt、限速)与刷新。
//!
//! 用本地起的极简 HTTP 服务当“文档站”,真实走 `reqwest` + 解析队列,不碰外网。

use std::sync::Arc;

use kb_core::config::UploadConfig;
use kb_core::model::{IngestFilter, IngestState, Job, JobState, Page};
use kb_core::ports::repo::IngestRepo;
use kb_service::index::IndexOptions;
use kb_service::upload::unpack::UnpackLimits;
use kb_service::{
    AddSourceRequest, IndexService, IngestJobHandler, IngestPayload, JobHandler, SourceService,
};
use kb_testkit::TestEnv;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const COLLECTION: &str = "_global";

/// 站点内容(测试中途可以改,模拟页面更新)。
type Site = Arc<std::sync::Mutex<Vec<(String, String)>>>;

/// 起一个极简 HTTP 服务,返回(基址, 可改的内容)。
async fn serve_site(pages: Vec<(&'static str, &'static str)>) -> (String, Site) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("绑定端口");
    let port = listener.local_addr().expect("地址").port();
    let site: Site = Arc::new(std::sync::Mutex::new(
        pages
            .into_iter()
            .map(|(path, body)| (path.to_owned(), body.to_owned()))
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

struct Harness {
    env: TestEnv,
    sources: SourceService,
    ingest: IngestJobHandler,
}

impl Harness {
    async fn new() -> Self {
        Self::new_with_skills(None).await
    }

    async fn new_with_skills(skills: Option<Arc<kb_service::SkillRegistry>>) -> Self {
        let env = TestEnv::new().await;
        let collections = kb_service::CollectionService::new(
            env.meta.clone(),
            env.store.clone(),
            env.embedder.clone(),
        );
        collections.ensure_global().await.expect("建 _global");
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
        let sources = SourceService::new(
            env.meta.clone(),
            env.store.clone(),
            env.scanner.clone(),
            paths,
            config,
        )
        // 测试用的网页服务器就在 127.0.0.1:默认(挡内网地址)下抓不到,这里明确打开
        .with_allow_private_web(true);
        let sources = match skills {
            Some(skills) => sources.with_skills(skills),
            None => sources,
        };
        Self {
            env,
            sources,
            ingest,
        }
    }

    async fn add_web_source(&self, url: &str, depth: u32) -> String {
        self.sources
            .add(AddSourceRequest {
                kind: Some("web".to_owned()),
                name: Some("文档站".to_owned()),
                uri: Some(url.to_owned()),
                collection: Some(COLLECTION.to_owned()),
                tags: Vec::new(),
                include: Vec::new(),
                exclude: Vec::new(),
                depth: Some(depth),
                allow_hosts: Vec::new(),
                refresh_minutes: None,
                ai_extract: None,
                extract_prompt: None,
            })
            .await
            .expect("添加网页数据源")
            .id
    }

    async fn run_ingest(&self, batch_id: &str) {
        let payload = IngestPayload {
            batch_id: batch_id.to_owned(),
            collection: COLLECTION.to_owned(),
        };
        let job = Job {
            id: format!("job-{batch_id}"),
            kind: "ingest".to_owned(),
            collection: Some(COLLECTION.to_owned()),
            priority: 60,
            state: JobState::Queued,
            payload_json: serde_json::to_string(&payload).expect("序列化"),
            checkpoint_json: None,
            detail: None,
            progress_done: 0,
            progress_total: None,
            rate: None,
            error: None,
            created_at: 1,
            started_at: None,
            finished_at: None,
        };
        // 分片跑到没有进度为止(与 worker 的调用方式一致)
        loop {
            let progress = self.ingest.run_slice(&job).await.expect("跑解析任务");
            if progress.done >= progress.total.unwrap_or(progress.done) {
                break;
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn crawls_a_site_with_depth_robots_and_host_whitelist() {
    let (base, _site) = serve_site(vec![
        ("/robots.txt", "User-agent: *\nDisallow: /private\n"),
        (
            "/index.html",
            r#"<html><head><title>文档首页</title></head><body>
<nav>导航链接</nav>
<h1>安装指南</h1><p>先安装工具链。</p>
<a href="/a.html">A</a><a href="/b.html">B</a>
<a href="/private/secret.html">秘密</a>
<a href="http://elsewhere.example/x.html">站外</a>
</body></html>"#,
        ),
        (
            "/a.html",
            "<html><body><h1>页面 A</h1><p>A 的正文内容。</p><a href=\"/deep/c.html\">C</a></body></html>",
        ),
        ("/b.html", "<html><body><h1>页面 B</h1><p>B 的正文内容。</p></body></html>"),
        ("/deep/c.html", "<html><body><p>第三层不应被抓到。</p></body></html>"),
        (
            "/private/secret.html",
            "<html><body><p>robots 禁止的页面。</p></body></html>",
        ),
    ])
    .await;

    let harness = Harness::new().await;
    let source_id = harness
        .add_web_source(&format!("{base}/index.html"), 2)
        .await;
    let outcome = harness
        .sources
        .sync("test", &source_id)
        .await
        .expect("同步");

    // 深度 2:index + a + b;c 在第三层,private 被 robots 挡住,站外被白名单挡住
    let files = IngestRepo::list(
        harness.env.meta.as_ref(),
        IngestFilter {
            collection: None,
            batch_id: Some(outcome.batch_id.clone()),
            source_id: Some(source_id.clone()),
            state: None,
        },
        Page::new(100, 0),
    )
    .await
    .expect("列文件");
    let mut paths: Vec<String> = files.iter().map(|file| file.rel_path.clone()).collect();
    paths.sort();
    let host_prefix = base.trim_start_matches("http://").replace(':', "_");
    assert_eq!(
        paths,
        vec![
            format!("{host_prefix}/a.html"),
            format!("{host_prefix}/b.html"),
            format!("{host_prefix}/index.html"),
        ],
        "只应抓到深度 2 内的同域页面:{files:?}"
    );

    // URL 出处:抓取目录之外有一份 urls.json(相对路径 → 原始 URL)
    let source_dir = harness.env.paths().source_dir(&source_id);
    let manifest_path = source_dir
        .parent()
        .expect("上级目录")
        .join(".urls")
        .join(format!("{source_id}.json"));
    let listing: Vec<String> = std::fs::read_dir(source_dir.parent().expect("上级"))
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    let manifest = std::fs::read_to_string(&manifest_path)
        .unwrap_or_else(|err| panic!("读 {manifest_path:?} 失败:{err};同级条目 = {listing:?}"));
    assert!(manifest.contains("/index.html"), "{manifest}");
    assert!(manifest.contains(&base), "清单里应有完整 URL:{manifest}");

    harness.run_ingest(&outcome.batch_id).await;
    let files = IngestRepo::list(
        harness.env.meta.as_ref(),
        IngestFilter {
            collection: None,
            batch_id: Some(outcome.batch_id.clone()),
            source_id: Some(source_id.clone()),
            state: None,
        },
        Page::new(100, 0),
    )
    .await
    .expect("列文件");
    for file in &files {
        assert_eq!(file.state, IngestState::Done, "{file:?}");
        assert!(file.chunks > 0, "每个页面都应有块:{file:?}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn refresh_only_requeues_changed_pages() {
    let (base, site) = serve_site(vec![
        ("/robots.txt", ""),
        (
            "/index.html",
            "<html><body><h1>首页</h1><p>第一版内容。</p><a href=\"/a.html\">A</a></body></html>",
        ),
        (
            "/a.html",
            "<html><body><p>页面 A 的第一版。</p></body></html>",
        ),
    ])
    .await;
    let harness = Harness::new().await;
    let source_id = harness
        .add_web_source(&format!("{base}/index.html"), 2)
        .await;
    let first = harness
        .sources
        .sync("test", &source_id)
        .await
        .expect("首次同步");
    harness.run_ingest(&first.batch_id).await;

    // 第二次同步:内容没变 → 不应重新入队
    let second = harness
        .sources
        .sync("test", &source_id)
        .await
        .expect("再次同步");
    assert_eq!(second.queued, 0, "内容没变时不应重新入队:{second:?}");
    assert!(second.job_id.is_none(), "没有入队就不该有任务");

    // 改一个页面的内容:只有它需要重新入队(刷新只重嵌入变化的页面)
    if let Ok(mut pages) = site.lock() {
        for (path, body) in pages.iter_mut() {
            if path == "/a.html" {
                *body =
                    "<html><body><p>页面 A 的第二版,内容变长了一些。</p></body></html>".to_owned();
            }
        }
    }
    let third = harness
        .sources
        .sync("test", &source_id)
        .await
        .expect("改后再同步");
    assert_eq!(third.queued, 1, "只有变化的页面应重新入队:{third:?}");
    assert!(third.job_id.is_some(), "有变化就该入队");
    harness.run_ingest(&third.batch_id).await;
    // 变化的页面复用原来的行(批次号还是首次同步那个),所以按路径查
    let host_prefix = base.trim_start_matches("http://").replace(':', "_");
    let changed = IngestRepo::get_by_path(
        harness.env.meta.as_ref(),
        COLLECTION,
        &format!("{host_prefix}/a.html"),
    )
    .await
    .expect("查文件")
    .expect("页面 A 的行应存在");
    assert_eq!(changed.state, IngestState::Done, "{changed:?}");
    // 没变的页面不应被重新入队(状态保持 Done 且没有新批次)
    let untouched = IngestRepo::get_by_path(
        harness.env.meta.as_ref(),
        COLLECTION,
        &format!("{host_prefix}/index.html"),
    )
    .await
    .expect("查文件")
    .expect("首页的行应存在");
    assert_eq!(untouched.state, IngestState::Done, "{untouched:?}");
    assert_eq!(
        untouched.batch_id.as_deref(),
        Some(first.batch_id.as_str()),
        "没变的页面应留在首次同步的批次里"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn scheduler_refreshes_only_due_sources() {
    // :设了 refresh_minutes 的数据源到点才刷新;刷新后只有变化页产生新块
    let (base, site) = serve_site(vec![
        ("/robots.txt", ""),
        (
            "/index.html",
            "<html><body><h1>首页</h1><p>第一版。</p><a href=\"/a.html\">A</a></body></html>",
        ),
        (
            "/a.html",
            "<html><body><p>页面 A 第一版。</p></body></html>",
        ),
    ])
    .await;
    let harness = Harness::new().await;
    let source_id = harness
        .sources
        .add(AddSourceRequest {
            kind: Some("web".to_owned()),
            name: Some("文档站".to_owned()),
            uri: Some(format!("{base}/index.html")),
            collection: Some(COLLECTION.to_owned()),
            tags: Vec::new(),
            include: Vec::new(),
            exclude: Vec::new(),
            depth: Some(2),
            allow_hosts: Vec::new(),
            refresh_minutes: Some(30),
            ai_extract: None,
            extract_prompt: None,
        })
        .await
        .expect("加数据源")
        .id;

    // 刚登记:不到点
    let now = kb_service::llm_gate::today_now_millis();
    let due = kb_service::refresh::due_sources(harness.env.meta.as_ref(), now)
        .await
        .expect("查到点");
    assert!(due.is_empty(), "刚登记不应到点:{due:?}");

    // 把 last_synced_at 拨回到 1 小时前 → 到点
    let mut source = harness.sources.get(&source_id).await.expect("取数据源");
    source.last_synced_at = Some(now - 60 * 60 * 1000);
    kb_core::ports::repo::SourceRepo::update(harness.env.meta.as_ref(), source)
        .await
        .expect("改同步时间");
    let due = kb_service::refresh::due_sources(harness.env.meta.as_ref(), now)
        .await
        .expect("查到点");
    assert_eq!(due.len(), 1, "{due:?}");
    assert_eq!(due[0].id, source_id);

    // 首次同步 + 跑完解析
    let first = harness
        .sources
        .sync("test", &source_id)
        .await
        .expect("首次同步");
    harness.run_ingest(&first.batch_id).await;

    // 改一页后再次同步:只有变化页入队
    if let Ok(mut pages) = site.lock() {
        for (path, body) in pages.iter_mut() {
            if path == "/a.html" {
                *body = "<html><body><p>页面 A 第二版。</p></body></html>".to_owned();
            }
        }
    }
    let second = harness
        .sources
        .sync("test", &source_id)
        .await
        .expect("刷新");
    assert_eq!(second.queued, 1, "只有变化的页面应重新入队:{second:?}");
}

// ---------------------------------------------------------------- 安全审查 S-2:网页来源 SSRF

/// 默认的抓取器(不允许私有地址)拒绝一切指向本机 / 内网的种子,而且**一个连接都不发**。
#[tokio::test]
async fn the_crawler_refuses_loopback_seeds_without_connecting() {
    use kb_service::sources_web::{CrawlOptions, WebCrawler};

    let listener = TcpListener::bind("127.0.0.1:0").await.expect("绑定端口");
    let port = listener.local_addr().unwrap().port();
    let crawler = WebCrawler::new(CrawlOptions::default()).expect("构造");
    for seed in [
        format!("http://127.0.0.1:{port}/"),
        format!("http://localhost:{port}/"),
        // 用户信息写法:看上去像 evil.example.com,实际连的是 127.0.0.1
        format!("http://evil.example.com@127.0.0.1:{port}/"),
        format!("http://[::1]:{port}/"),
        format!("http://2130706433:{port}/"),
        format!("http://0x7f.0.0.1:{port}/"),
        "http://169.254.169.254/latest/meta-data/iam/security-credentials/".to_owned(),
    ] {
        let err = crawler
            .crawl(&seed)
            .await
            .expect_err(&format!("应拒绝 {seed}"));
        assert!(
            matches!(err, kb_core::KbError::InvalidInput(_)),
            "{seed}: {err}"
        );
    }
    let connected = tokio::time::timeout(std::time::Duration::from_millis(300), listener.accept())
        .await
        .is_ok();
    assert!(!connected, "被拒绝的种子不能发出任何连接");
}

/// 管理员明确放开(`[network] crawl_allow_private`)之后,同一个本机站点就能抓了。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn allowing_private_hosts_is_an_explicit_opt_in() {
    use kb_service::sources_web::{CrawlOptions, WebCrawler};

    let (base, _site) = serve_site(vec![("/", "<html><body><p>内网文档</p></body></html>")]).await;
    let refused = WebCrawler::new(CrawlOptions::default())
        .unwrap()
        .crawl(&base)
        .await;
    assert!(refused.is_err());
    let allowed = WebCrawler::new(CrawlOptions::default().with_allow_private(true))
        .unwrap()
        .crawl(&base)
        .await
        .expect("明确放开后可以抓");
    assert_eq!(allowed.pages.len(), 1);
}

/// :插件的 source 钩子可以接管网页来源,完全不发网络请求。
#[tokio::test]
async fn plugin_source_hook_replaces_the_web_crawler() {
    let skills_dir = tempfile::tempdir().expect("skills 目录");
    let plugin_dir = skills_dir.path().join("fake-web");
    std::fs::create_dir_all(&plugin_dir).expect("建插件目录");
    std::fs::write(
        plugin_dir.join("plugin.py"),
        r#"import json
import sys

for line in sys.stdin:
    req = json.loads(line)
    rid = req.get("id")
    if req.get("method") == "initialize":
        result = {"api_version": 1}
    elif req.get("method") == "shutdown":
        break
    elif req.get("method") == "source":
        result = {"pages": [{
            "url": "https://plugin.example/docs",
            "rel_path": "plugin.example/index.html",
            "content": "<html><body><h1>插件来源</h1><p>没有经过网络。</p></body></html>",
            "content_type": "text/html"
        }]}
    else:
        result = {"error": "unknown"}
    print(json.dumps({"jsonrpc": "2.0", "id": rid, "result": result}), flush=True)
"#,
    )
    .expect("写插件脚本");
    std::fs::write(
        plugin_dir.join("manifest.toml"),
        r#"
type = "plugin"
name = "fake-web"
version = "0.1.0"
api_version = 1
[source]
match = ["https://plugin.example/*"]
[exec]
command = "python3"
args = ["plugin.py"]
hooks = ["source"]
"#,
    )
    .expect("写清单");

    let registry = kb_service::SkillRegistry::load_with_options(skills_dir.path(), true, true);
    assert!(registry.warnings().is_empty(), "{:?}", registry.warnings());
    let harness = Harness::new_with_skills(Some(Arc::new(registry))).await;
    let source_id = harness
        .add_web_source("https://plugin.example/docs", 1)
        .await;
    let outcome = harness
        .sources
        .sync("test", &source_id)
        .await
        .expect("同步");
    assert_eq!(outcome.queued, 1, "插件页面应进入解析队列:{outcome:?}");

    let files = IngestRepo::list(
        harness.env.meta.as_ref(),
        IngestFilter {
            collection: None,
            batch_id: Some(outcome.batch_id.clone()),
            source_id: Some(source_id.clone()),
            state: None,
        },
        Page::new(100, 0),
    )
    .await
    .expect("列文件");
    assert_eq!(files.len(), 1, "{files:?}");
    assert_eq!(files[0].rel_path, "plugin.example/index.html");
    let page = harness
        .env
        .paths()
        .source_dir(&source_id)
        .join("plugin.example/index.html");
    let html = std::fs::read_to_string(&page).expect("读插件页面");
    assert!(html.contains("插件来源"), "{html}");

    // 出处清单也要换成插件这一轮的 URL,否则旧页面删了、清单还指着它
    let manifest = harness
        .env
        .paths()
        .source_dir(&source_id)
        .parent()
        .expect("sources 目录")
        .join(".urls")
        .join(format!("{source_id}.json"));
    let manifest = std::fs::read_to_string(manifest).expect("读 URL 清单");
    assert!(
        manifest.contains("https://plugin.example/docs"),
        "{manifest}"
    );
}
