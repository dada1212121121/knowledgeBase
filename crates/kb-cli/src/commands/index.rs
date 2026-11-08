//! `kb index`:全量 / 增量索引,以及 `--global` 导入文档。

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use kb_core::KbError;
use kb_core::config::Config;
use kb_core::model::{Job, JobState};
use kb_core::paths::KbPaths;
use kb_service::JobQueue;
use kb_service::jobs::{IndexCheckpoint, IndexJobHandler, IndexPayload, JobRouter, NewJob, Worker};
use tokio::sync::watch;

use crate::error::CliError;
use crate::runtime::Embedded;

/// `kb index` 的参数。
#[derive(Clone, Debug)]
pub struct IndexArgs {
    /// 项目名(与 `--global` 二选一)。
    pub project: Option<String>,
    /// 强制全量。
    pub full: bool,
    /// 只处理这些路径(增量)。
    pub paths: Vec<String>,
    /// 把文件或目录导入 `_global`。
    pub global: Option<PathBuf>,
    /// 导入 `_global` 时附加的标签。
    pub tag: Vec<String>,
    /// 强制走守护进程。
    pub remote: bool,
    /// 强制嵌入式。
    pub local: bool,
    /// 只写正文(文本优先索引的第一阶段)。
    pub text_only: bool,
    /// 只排空待补向量队列。
    pub embed_pending: bool,
}

/// 已有任务是否就是这次要跑的阶段。
///
/// 正常索引可以续跑任何非手工收尾的任务(包括文本优先任务自动切到 embed);但两个手动
/// 开关必须严格匹配 payload,否则会出现「想只写正文,却把上一轮的队列补完」或反过来。
fn same_requested_stage(
    job: &Job,
    text_only: bool,
    embed_pending: bool,
    requested_paths: &[String],
) -> bool {
    let payload = match serde_json::from_str::<IndexPayload>(&job.payload_json) {
        Ok(payload) => payload,
        // payload 坏了交给 worker 报错;不要在这里另起任务把真正的错误盖住。
        Err(_) => return !text_only && !embed_pending,
    };
    let stage_matches = if text_only {
        payload.phase.as_deref() == Some("text") && payload.stop_after_text
    } else if embed_pending {
        payload.phase.as_deref() == Some("embed") && !payload.stop_after_text
    } else {
        // 手工 `--text-only` 会在文本阶段停;手工 `--embed-pending` 只排队列,都不算
        // 「一次完整索引」,不能拿来续跑普通的 `kb index`。
        payload.phase.as_deref() != Some("embed") && !payload.stop_after_text
    };
    if !stage_matches {
        return false;
    }
    // 嵌入式续跑同样受检查点约束:分片任务已经固化了文件顺序,新给的路径不在
    // checkpoint 里就永远不会被处理。守护进程的队列合并已经按这个口径排除了带
    // checkpoint 的任务,这里也不能例外。`--embed-pending` / 空路径是整表任务,
    // 没有「新路径」问题。
    if embed_pending || requested_paths.is_empty() {
        return true;
    }
    let Some(checkpoint_json) = job.checkpoint_json.as_deref() else {
        return true;
    };
    let Ok(checkpoint) = serde_json::from_str::<IndexCheckpoint>(checkpoint_json) else {
        // 检查点坏了交给 worker 报错;这里另起任务会把真正的错误盖住。
        return false;
    };
    // 满量任务的检查点可能没有路径列表(每片重新扫描);此时无法判定新旧,保持旧行为。
    checkpoint.paths.is_empty()
        || requested_paths
            .iter()
            .all(|path| checkpoint.paths.iter().any(|known| known == path))
}

/// 执行索引。
pub async fn run(paths: &KbPaths, config: &Config, args: IndexArgs) -> Result<ExitCode, CliError> {
    // `_global` 导入走同步全量路径(没有 job / 队列),两个两阶段开关在这里没有意义;
    // 与其静默忽略,不如直接拒绝,避免用户以为正文已经先落库。
    if args.global.is_some() && (args.text_only || args.embed_pending) {
        return Err(KbError::InvalidInput(
            "`--text-only` / `--embed-pending` 目前只支持项目索引,不支持 `--global`".to_owned(),
        )
        .into());
    }
    if let Some(global_path) = args.global.clone() {
        return index_global(
            paths,
            config,
            global_path,
            &args.tag,
            args.local,
            args.remote,
        )
        .await;
    }
    let Some(name) = args.project.clone() else {
        return Err(KbError::InvalidInput(
            "请指定项目名,或用 `kb index --global <文件或目录>`".to_owned(),
        )
        .into());
    };

    // 设计规范的模式规则:--remote 必须走守护进程;默认能连上就走守护进程,否则嵌入式
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
        let mode = if args.full || args.embed_pending || args.paths.is_empty() {
            "full"
        } else {
            "incremental"
        };
        let phase = if args.text_only {
            Some("text")
        } else if args.embed_pending {
            Some("embed")
        } else {
            None
        };
        let data = client
            .call(
                "reindex_project",
                serde_json::json!({
                    "project": name,
                    "mode": mode,
                    "paths": args.paths,
                    "phase": phase,
                    "stop_after_text": args.text_only,
                }),
                &kb_mcp::uds::CallOptions {
                    cwd: std::env::current_dir()
                        .ok()
                        .map(|path| path.to_string_lossy().into_owned()),
                    client: None,
                    project: Some(name.clone()),
                    surface: Some("web".to_owned()),
                    dry_run: false,
                },
            )
            .await?;
        println!(
            "已通过守护进程投递任务 {}",
            data.get("job_id")
                .and_then(|value| value.as_str())
                .unwrap_or("-")
        );
        return Ok(ExitCode::SUCCESS);
    }

    let runtime = Embedded::open(paths, config, true).await?;
    let project = runtime.projects().resolve(&name).await?;
    let collection_name = format!("proj_{}", project.slug);
    runtime
        .collections()
        .get(&collection_name)
        .await?
        .ok_or_else(|| KbError::NotFound(format!("collection {collection_name}")))?;
    // 正常索引必须要嵌入:先触发模型加载,失败直接报错而不是让每个文件都失败。
    // 手动 `--text-only` 例外:这一趟只写正文,加载嵌入模型纯属浪费,补向量时再报错也不迟。
    if !args.text_only {
        runtime
            .warm_embedder(std::time::Duration::from_secs(120))
            .await?;
    }
    let queue = runtime.queue();

    // 嵌入式写模式已经拿到 run/daemon.lock,这里没有别的写者:
    // 把上次崩溃 / 被强杀留下的 running 任务改回 queued,才能续跑
    let recovered = queue.recover().await?;
    if recovered > 0 {
        println!("恢复了 {recovered} 个上次中断的任务");
    }
    // 正在解析的文件会卡在 extracting / chunking / embedding:它们既不在队列里也不算完成,
    // 不回队就永远跑不完(批次还会提前收尾)
    match kb_service::IngestService::new(runtime.meta.clone())
        .recover_inflight()
        .await
    {
        Ok(0) => {}
        Ok(requeued) => println!("重新入队了 {requeued} 个上次中断时在处理中的文件"),
        Err(err) => eprintln!("恢复处理中的文件失败:{err}"),
    }

    // 已有排队中/运行中的索引任务 → 从检查点继续
    let mut existing = queue.list(Some(JobState::Queued)).await?;
    existing.extend(queue.list(Some(JobState::Running)).await?);
    let job = match existing.into_iter().find(|job| {
        job.kind == "index"
            && job.collection.as_deref() == Some(collection_name.as_str())
            // 手动阶段开关只能续跑同一阶段的任务:续跑一个 `--embed-pending` 任务却想
            // `--text-only`,会把整张表的向量补完;续跑一个 `--text-only` 任务却想普通索引,
            // 又会在文本阶段结束就停,队列里的块永远补不上。
            && same_requested_stage(job, args.text_only, args.embed_pending, &args.paths)
    }) {
        Some(job) => {
            println!("发现未完成的任务 {},从检查点继续……", job.id);
            job
        }
        None => {
            let mut request = if args.full || args.embed_pending || args.paths.is_empty() {
                NewJob::full_index(&project.id, &collection_name)
            } else {
                NewJob::incremental_index(&project.id, &collection_name, &args.paths)
            };
            if args.text_only {
                // 嵌入式模式与守护进程走同一套 payload,避免两条链路行为不一致
                request.payload["phase"] = serde_json::Value::String("text".to_owned());
                request.payload["stop_after_text"] = serde_json::Value::Bool(true);
            } else if args.embed_pending {
                request.payload["phase"] = serde_json::Value::String("embed".to_owned());
            }
            queue.enqueue(request).await?
        }
    };

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    spawn_signal_handler(shutdown_tx);
    let index_handler = Arc::new(IndexJobHandler::new(
        Arc::new(runtime.index_service()),
        runtime.meta.clone(),
        1,
    ));
    let mut router = JobRouter::new();
    router.register("index", index_handler);
    // insight 的嵌入任务(优先级 90)由同一个 worker 处理(CLI 里逐个跑,守护进程里并行跑)
    router.register(
        "save_insight",
        Arc::new(kb_service::insight::InsightJobHandler::new(
            runtime.meta.clone(),
            runtime.store(),
            runtime.embedder.clone(),
        )),
    );
    // 上传解析任务也可能排在这里,嵌入式模式一并处理,免得任务被判“没有处理器”
    router.register(
        "ingest",
        Arc::new(
            kb_service::IngestJobHandler::new(
                Arc::new(runtime.index_service()),
                runtime.meta.clone(),
                runtime.paths.clone(),
                kb_service::upload::unpack::UnpackLimits {
                    max_ratio: runtime.config().upload.unpack_max_ratio,
                    max_depth: runtime.config().upload.unpack_max_depth,
                    max_files: runtime.config().upload.unpack_max_files,
                    max_bytes: runtime.config().upload.max_file_mb * 1024 * 1024,
                    max_total_bytes: runtime.config().upload.max_total_gb * 1024 * 1024 * 1024,
                },
                10,
                Arc::new(kb_service::ProgressTracker::new(
                    runtime.meta.clone(),
                    crate::capability_backend::embed_backend_badge(&runtime.config()),
                )),
            )
            // 嵌入式模式是一次性进程:按启动时的配置取一次,没有热更新的必要
            .with_parallel_files({
                let parallel = runtime.config().index.parallel_files as usize;
                Arc::new(move || parallel)
            }),
        ),
    );
    let worker = Worker::new(Arc::new(queue.clone()), Arc::new(router), shutdown_rx);

    let poller = spawn_progress_printer(queue.clone(), job.id.clone());
    worker.run_until_idle().await?;
    poller.abort();

    let finished = queue
        .get(&job.id)
        .await?
        .ok_or_else(|| KbError::Internal("任务记录不见了".to_owned()))?;
    println!();
    print_summary(&finished.state, finished.checkpoint_json.as_deref());
    if let Some(error) = finished.error.as_deref()
        && !error.trim().is_empty()
    {
        println!("出错的条目:");
        for line in error.lines().take(5) {
            println!("  - {line}");
        }
    }
    match finished.state {
        JobState::Done => Ok(ExitCode::SUCCESS),
        JobState::Queued => {
            println!("任务已保存检查点并退出;再次运行 `kb index {name}` 会继续。");
            Ok(ExitCode::SUCCESS)
        }
        other => Err(KbError::Internal(format!(
            "索引任务未完成:{}({})",
            other.as_str(),
            finished.error.as_deref().unwrap_or("-")
        ))
        .into()),
    }
}

async fn index_global(
    paths: &KbPaths,
    config: &Config,
    path: PathBuf,
    tags: &[String],
    local: bool,
    remote: bool,
) -> Result<ExitCode, CliError> {
    if !path.exists() {
        return Err(KbError::InvalidInput(format!("{} 不存在", path.display())).into());
    }
    // 守护进程在跑时走 UDS(导入会写向量表,不需要 `run/daemon.lock`,也不该逼用户停服)。
    let client = kb_mcp::uds::UdsClient::new(paths.socket());
    let running = client.is_running().await;
    let use_remote = if remote {
        if !running {
            return Err(CliError::DaemonNotRunning);
        }
        true
    } else if local {
        false
    } else {
        running
    };
    if use_remote {
        let data = client
            .call(
                "import_global",
                serde_json::json!({
                    "path": path.to_string_lossy(),
                    "tags": tags,
                }),
                &kb_mcp::uds::CallOptions {
                    cwd: std::env::current_dir()
                        .ok()
                        .map(|value| value.to_string_lossy().into_owned()),
                    client: None,
                    project: None,
                    surface: Some("web".to_owned()),
                    dry_run: false,
                },
            )
            .await?;
        print_global_report(&data);
        return Ok(ExitCode::SUCCESS);
    }
    let runtime = Embedded::open(paths, config, true).await?;
    let global = runtime.collections().ensure_global().await?;
    let report = runtime
        .index_service()
        .index_global_path(&global, &path, tags)
        .await?;
    print_global_report(&serde_json::json!({
        "scanned": report.scanned,
        "chunks": report.chunks,
        "embedded": report.embedded,
        "errors": report.errors,
    }));
    Ok(ExitCode::SUCCESS)
}

/// 打印 `--global` 导入结果(嵌入式与 UDS 共用)。
fn print_global_report(data: &serde_json::Value) {
    println!(
        "已导入 {} 个文件,共 {} 块,嵌入 {} 块",
        data.get("scanned")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
        data.get("chunks")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
        data.get("embedded")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
    );
    for error in data
        .get("errors")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        eprintln!("失败: {}", error.as_str().unwrap_or_default());
    }
}

/// 第一次信号(SIGINT / SIGTERM / SIGHUP):处理完当前文件、保存检查点后退出;
/// 第二次立即退出(任务会留在 running,下次启动时由 recover 续跑)。
fn spawn_signal_handler(tx: watch::Sender<bool>) {
    tokio::spawn(async move {
        use tokio::signal::unix::{SignalKind, signal};

        let Ok(mut interrupt) = signal(SignalKind::interrupt()) else {
            return;
        };
        let Ok(mut terminate) = signal(SignalKind::terminate()) else {
            return;
        };
        let Ok(mut hangup) = signal(SignalKind::hangup()) else {
            return;
        };
        let mut count = 0usize;
        loop {
            tokio::select! {
                _ = interrupt.recv() => {}
                _ = terminate.recv() => {}
                _ = hangup.recv() => {}
            }
            count += 1;
            if count >= 2 {
                eprintln!("\n第二次中断信号:立即退出(下次运行会从检查点继续)");
                std::process::exit(130);
            }
            eprintln!("\n收到中断信号:处理完当前文件并保存检查点后退出(再按一次立即退出)");
            let _ = tx.send(true);
        }
    });
}

/// 每 500ms 打印一次进度。
fn spawn_progress_printer(queue: JobQueue, job_id: String) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let queue = Arc::new(queue);
        loop {
            tokio::time::sleep(Duration::from_millis(500)).await;
            let Ok(Some(job)) = queue.get(&job_id).await else {
                break;
            };
            let checkpoint = job
                .checkpoint_json
                .as_deref()
                .and_then(|json| serde_json::from_str::<IndexCheckpoint>(json).ok());
            let embedded = checkpoint.as_ref().map(|value| value.embedded).unwrap_or(0);
            let pending = checkpoint.as_ref().map(|value| value.pending).unwrap_or(0);
            // 补向量任务在第一个分片落库前还没有 checkpoint,只能看 payload 的阶段;
            // 否则进度会先把「块」报成「文件」,用户以为在扫目录。
            let payload_phase = serde_json::from_str::<IndexPayload>(&job.payload_json)
                .ok()
                .and_then(|value| value.phase);
            let embedding = checkpoint
                .as_ref()
                .map(|value| value.phase == "embed")
                .unwrap_or(false)
                || payload_phase.as_deref() == Some("embed");
            let unit = if embedding { "块" } else { "文件" };
            let total = job.progress_total.unwrap_or(0);
            let eta = kb_service::jobs::queue::eta_seconds(
                job.progress_done,
                job.progress_total,
                embedded as u64,
                job.rate,
            );
            let eta_text = eta
                .map(|seconds| format!("{:.0}s", seconds))
                .unwrap_or_else(|| "-".to_owned());
            if pending > 0 {
                eprint!(
                    "\r进度 {}/{} {unit} · 正文 {} 块 · 嵌入 {} 块 · 剩余 {}      ",
                    job.progress_done, total, pending, embedded, eta_text
                );
            } else {
                eprint!(
                    "\r进度 {}/{} {unit} · 嵌入 {} 块 · 剩余 {}      ",
                    job.progress_done, total, embedded, eta_text
                );
            }
            if !matches!(job.state, JobState::Queued | JobState::Running) {
                break;
            }
        }
    })
}

fn print_summary(state: &JobState, checkpoint: Option<&str>) {
    let checkpoint = checkpoint
        .and_then(|json| serde_json::from_str::<IndexCheckpoint>(json).ok())
        .unwrap_or_default();
    if checkpoint.phase == "embed" {
        // 补向量任务按块推进,没有「文件」概念;别把队列条数报成文件数。
        println!("补向量 {} 块", checkpoint.embedded);
        println!(
            "更新元数据 {} 块,删除 {} 块,错误 {} 个",
            checkpoint.updated_meta, checkpoint.deleted_chunks, checkpoint.errors
        );
        if matches!(state, JobState::Done) {
            println!("索引完成。");
        }
        return;
    }
    if checkpoint.pending > 0 {
        // 只写了正文的手动 `--text-only`:向量还在队列里,不能报成「0 个块需要嵌入」
        println!(
            "待补向量 {} 块(用 `kb index --embed-pending` 继续)",
            checkpoint.pending
        );
    } else if checkpoint.embedded == 0 {
        println!("0 个块需要嵌入");
    } else {
        println!("嵌入 {} 块", checkpoint.embedded);
    }
    println!(
        "更新元数据 {} 块,删除 {} 块,文件 {} 个,错误 {} 个",
        checkpoint.updated_meta, checkpoint.deleted_chunks, checkpoint.done, checkpoint.errors
    );
    if matches!(state, JobState::Done) {
        println!("索引完成。");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(payload: serde_json::Value) -> Job {
        Job {
            id: "j1".to_owned(),
            kind: "index".to_owned(),
            collection: Some("proj_demo".to_owned()),
            priority: 20,
            state: JobState::Queued,
            payload_json: payload.to_string(),
            checkpoint_json: None,
            detail: None,
            progress_done: 0,
            progress_total: None,
            rate: None,
            error: None,
            created_at: 1,
            started_at: None,
            finished_at: None,
        }
    }

    #[test]
    fn manual_stage_only_resumes_the_same_stage() {
        let text_only = job(serde_json::json!({
            "project_id": "p1", "mode": "full", "phase": "text", "stop_after_text": true
        }));
        let embed_pending = job(serde_json::json!({
            "project_id": "p1", "mode": "full", "phase": "embed"
        }));
        let normal = job(serde_json::json!({"project_id": "p1", "mode": "full"}));

        assert!(same_requested_stage(&text_only, true, false, &[]));
        assert!(!same_requested_stage(&text_only, false, true, &[]));
        assert!(!same_requested_stage(&text_only, false, false, &[]));
        assert!(same_requested_stage(&embed_pending, false, true, &[]));
        assert!(!same_requested_stage(&embed_pending, true, false, &[]));
        assert!(!same_requested_stage(&embed_pending, false, false, &[]));
        assert!(same_requested_stage(&normal, false, false, &[]));
        assert!(!same_requested_stage(&normal, true, false, &[]));
        assert!(!same_requested_stage(&normal, false, true, &[]));
    }

    #[test]
    fn a_checkpoint_prevents_resuming_with_paths_it_never_snapshotted() {
        let mut job = job(serde_json::json!({
            "project_id": "p1", "mode": "full", "phase": "text", "stop_after_text": true
        }));
        let checkpoint = IndexCheckpoint {
            paths: vec!["src/a.rs".to_owned()],
            next: 0,
            total: 1,
            done: 0,
            errors: 0,
            embedded: 0,
            updated_meta: 0,
            deleted_chunks: 0,
            rows_since_optimize: 0,
            error_samples: Vec::new(),
            skipped_recorded: false,
            phase: "text".to_owned(),
            pending: 0,
        };
        job.checkpoint_json = Some(serde_json::to_string(&checkpoint).expect("序列化检查点"));

        assert!(same_requested_stage(
            &job,
            true,
            false,
            &["src/a.rs".to_owned()]
        ));
        assert!(
            !same_requested_stage(&job, true, false, &["src/b.rs".to_owned()]),
            "检查点里没有的新路径不能被旧任务吞掉"
        );
        assert!(
            same_requested_stage(&job, true, false, &[]),
            "空路径是整表任务,仍应从检查点续跑"
        );
    }
}
