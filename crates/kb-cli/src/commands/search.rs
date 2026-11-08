//! `kb search`:检索项目 / `_global`,输出格式与 MCP 一致（设计规范）。

use std::process::ExitCode;
use std::time::Instant;

use kb_core::config::Config;
use kb_core::paths::KbPaths;
use kb_core::ports::repo::{CollectionRepo, ProjectRepo};
use kb_core::render::{RenderOptions, render_hits};
use kb_service::ProjectService;
use kb_service::search::{SearchOptions, SearchRequest, SearchService};

use crate::error::CliError;
use crate::runtime::Embedded;

/// `kb search` 的参数。
#[derive(Clone, Debug)]
pub struct SearchArgs {
    /// 查询串(支持 `kind:` / `path:` / `status:` 等前缀)。
    pub query: String,
    /// 只搜这个项目(默认按当前目录匹配)。
    pub project: Option<String>,
    /// 额外的 kind 过滤,可重复。
    pub kind: Vec<String>,
    /// 返回条数。
    pub k: Option<usize>,
    /// 输出各阶段排名。
    pub explain: bool,
    /// 输出 JSON(设计规范的响应形状)。
    pub json: bool,
    /// 强制嵌入式模式。
    pub local: bool,
    /// 强制走守护进程。
    pub remote: bool,
    /// `KB_PROJECT` 的值(由 `main` 读一次后显式传入,服务层不再读环境变量)。
    pub env_project: Option<String>,
}

/// 执行检索。
pub async fn run(paths: &KbPaths, config: &Config, args: SearchArgs) -> Result<ExitCode, CliError> {
    let process_started = Instant::now();

    // 设计规范的 CLI 模式规则:--remote > --local > 守护进程在跑就走 UDS,否则嵌入式
    let client = kb_mcp::uds::UdsClient::new(paths.socket());
    let running = client.is_running().await;
    let use_remote = if args.remote {
        if !running {
            return Err(CliError::DaemonNotRunning);
        }
        true
    } else if args.local {
        false
    } else {
        running
    };
    if use_remote {
        return run_remote(
            &client,
            &args,
            config.search.mcp_max_output_chars,
            process_started,
        )
        .await;
    }

    let runtime = Embedded::open(paths, config, false).await?;
    let collections = resolve_scope(
        &runtime,
        args.project.as_deref().or(args.env_project.as_deref()),
    )
    .await?;
    if collections.is_empty() {
        eprintln!("还没有任何已索引的 collection,先运行 `kb index <项目>`。");
        if args.json {
            let envelope = serde_json::json!({
                "ok": true,
                "data": { "hits": [], "scope": [], "query_parsed": null },
                "meta": { "took_ms": 0, "dry_run": false, "degraded": null, "warnings": [] },
            });
            println!(
                "{}",
                serde_json::to_string_pretty(&envelope).unwrap_or_default()
            );
        }
        return Ok(ExitCode::SUCCESS);
    }

    let mut query = args.query.clone();
    for kind in &args.kind {
        query.push_str(&format!(" kind:{kind}"));
    }

    // 预热:CLI 是单次进程,LanceDB 的表句柄与倒排索引都是首次查询时才加载(约 150–250ms)。
    // 守护进程里它们常驻,设计规范的延迟目标也是按“embedder 已就绪”的口径,
    // 所以先用一次最小全文查询把表打开,再开始计时。
    // 模型是惰性加载的:先触发一次加载,失败才降级(设计规范第 3 步)
    if let Err(err) = runtime
        .warm_embedder(std::time::Duration::from_secs(30))
        .await
    {
        eprintln!("嵌入模型不可用,本次只做全文检索:{err}");
    }

    let store = runtime.store();
    for name in &collections {
        if let Some(collection) = CollectionRepo::get(runtime.meta.as_ref(), name).await? {
            let _ = store
                .search(
                    &collection.active_table,
                    &kb_core::model::StoreQuery {
                        mode: kb_core::model::SearchMode::Fts,
                        text: Some("kb".to_owned()),
                        vector: None,
                        filter: kb_core::filter::Filter::default(),
                        limit: 1,
                        offset: 0,
                        with_vector: false,
                    },
                )
                .await;
        }
    }

    let service = SearchService::new(
        runtime.meta.clone(),
        store,
        runtime.embedder.clone(),
        crate::runtime::build_reranker(config),
        SearchOptions::from_config(config),
    )
    // 待补向量队列的 2 秒缓存:同一个知识库内跨请求共享
    .with_pending_cache(runtime.pending_cache.clone());
    let started = Instant::now();
    let response = service
        .search(SearchRequest {
            query,
            collections: collections.clone(),
            k: args.k,
            explain: args.explain,
            rerank: None,
        })
        .await?;
    let took_ms = started.elapsed().as_millis();

    if args.json {
        let data = serde_json::json!({
            "hits": response.hits,
            "scope": response.scope,
            "query_parsed": response.query_parsed,
            // `--explain` 才有:各阶段耗时,含 的排队时间
            "timings": response.timings,
        });
        let envelope = serde_json::json!({
            "ok": true,
            "data": data,
            "meta": {
                "took_ms": took_ms,
                "dry_run": false,
                "degraded": response.degraded,
                "warnings": [],
            },
        });
        println!(
            "{}",
            serde_json::to_string_pretty(&envelope).unwrap_or_default()
        );
    } else {
        let options = RenderOptions {
            max_chars: config.search.mcp_max_output_chars,
            snippet_chars: if args.explain { 400 } else { 600 },
        };
        print!(
            "{}",
            render_hits(&response.hits, response.degraded.as_deref(), &options)
        );
    }
    eprintln!(
        "耗时 {took_ms} ms(检索,不含模型加载){}· 总耗时 {} ms(作用域:{})",
        queue_suffix(response.timings.map(|t| t.queue_ms)),
        process_started.elapsed().as_millis(),
        response.scope.join(", ")
    );
    Ok(ExitCode::SUCCESS)
}

/// 通过守护进程检索。
async fn run_remote(
    client: &kb_mcp::uds::UdsClient,
    args: &SearchArgs,
    max_chars: usize,
    process_started: Instant,
) -> Result<ExitCode, CliError> {
    let mut query = args.query.clone();
    for kind in &args.kind {
        query.push_str(&format!(" kind:{kind}"));
    }
    // 设计规范:显式 --project > KB_PROJECT
    let project = args.project.clone().or_else(|| args.env_project.clone());
    let started = Instant::now();
    let data = client
        .call(
            "search_knowledge",
            serde_json::json!({
                "query": query,
                "k": args.k,
                "explain": args.explain,
                "project": project,
            }),
            &kb_mcp::uds::CallOptions {
                cwd: std::env::current_dir()
                    .ok()
                    .map(|path| path.to_string_lossy().into_owned()),
                client: None,
                project: project.clone(),
                surface: Some("web".to_owned()),
                dry_run: false,
            },
        )
        .await?;
    let took_ms = started.elapsed().as_millis();
    let hits: Vec<kb_core::model::SearchHit> =
        serde_json::from_value(data.get("hits").cloned().unwrap_or(serde_json::json!([])))
            .map_err(|err| kb_core::KbError::Internal(format!("解析命中失败: {err}")))?;
    let scope: Vec<String> =
        serde_json::from_value(data.get("scope").cloned().unwrap_or(serde_json::json!([])))
            .unwrap_or_default();
    let degraded = data
        .get("degraded")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);

    if args.json {
        let envelope = serde_json::json!({
            "ok": true,
            "data": data,
            "meta": {
                "took_ms": took_ms,
                "dry_run": false,
                "degraded": degraded,
                "warnings": [],
            },
        });
        println!(
            "{}",
            serde_json::to_string_pretty(&envelope).unwrap_or_default()
        );
    } else {
        let options = RenderOptions {
            max_chars,
            snippet_chars: if args.explain { 400 } else { 600 },
        };
        print!("{}", render_hits(&hits, degraded.as_deref(), &options));
    }
    // 经守护进程时 timings 来自能力响应(只有 --explain 才有)
    let queue_ms = data
        .get("timings")
        .and_then(|timings| timings.get("queue_ms"))
        .and_then(serde_json::Value::as_f64);
    eprintln!(
        "耗时 {took_ms} ms(经守护进程){}· 总耗时 {} ms(作用域:{})",
        queue_suffix(queue_ms),
        process_started.elapsed().as_millis(),
        scope.join(", ")
    );
    Ok(ExitCode::SUCCESS)
}

/// 「排了多久」的尾巴:只有真排过队(>1 ms)才写,免得每行都挂一个 `排队 0 ms`。
fn queue_suffix(queue_ms: Option<f64>) -> String {
    match queue_ms {
        Some(ms) if ms > 1.0 => format!("· 排队 {ms:.0} ms "),
        _ => String::new(),
    }
}

/// 解析检索作用域:`--project` > `KB_PROJECT` > 当前目录匹配 > 全部 collection。
async fn resolve_scope(runtime: &Embedded, project: Option<&str>) -> Result<Vec<String>, CliError> {
    let projects = ProjectService::new(
        runtime.meta.clone(),
        runtime.store(),
        runtime.embedder.clone(),
    );
    let explicit = match project {
        Some(name) => Some(projects.resolve(name).await?),
        None => {
            let cwd = std::env::current_dir().unwrap_or_default();
            ProjectRepo::match_cwd(runtime.meta.as_ref(), &cwd.to_string_lossy()).await?
        }
    };
    if let Some(project) = explicit {
        return Ok(vec![format!("proj_{}", project.slug), "_global".to_owned()]);
    }
    // 没有匹配到项目:搜全部 collection
    let all = CollectionRepo::list(runtime.meta.as_ref()).await?;
    Ok(all.into_iter().map(|collection| collection.name).collect())
}
