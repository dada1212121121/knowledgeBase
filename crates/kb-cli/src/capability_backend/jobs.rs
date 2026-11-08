//! 任务:作业、批次、摄取、统计与评测、数据源。

use crate::capability_backend::*;

/// 从 payload 提取适合展示在任务列表的一句话详情。
fn extract_job_detail(job: &kb_core::model::Job) -> Option<String> {
    if job.payload_json.is_empty() {
        return None;
    }
    let val: Value = serde_json::from_str(&job.payload_json).ok()?;
    let paths = val.get("paths").and_then(Value::as_array);
    let text = |key: &str| val.get(key).and_then(Value::as_str);
    // 拼法与列表查询共用一份(`job_detail_hint`),这里只负责从完整 payload 里取出参数
    kb_core::model::job_detail_hint(
        paths.map(Vec::len),
        paths
            .and_then(|items| items.first())
            .and_then(Value::as_str),
        text("mode"),
        text("insight_id"),
        text("batch_id"),
        text("path"),
    )
}

/// 任务列表里的一条:去掉 `payload_json` / `checkpoint_json`,提取一句话 `detail`。
///
/// 这两个是任务的内部状态,界面和 MCP 都不看;索引任务的单条能到几 MB,整张列表因此从 5 MB 涨到 29 MB。
/// 要完整内容用 `job_get`。
fn job_summary(job: &kb_core::model::Job) -> Result<Value> {
    // 列表查询已经用 SQL 取好的标量拼过详情(`Job::detail`);完整查询(job_get)没有,
    // 这时从 payload 现解一次,两条路径的拼法共用 `job_detail_hint`
    let detail = job.detail.clone().or_else(|| extract_job_detail(job));
    let mut value = serde_json::to_value(job)
        .map_err(|err| KbError::Internal(format!("序列化任务失败: {err}")))?;
    if let Some(object) = value.as_object_mut() {
        object.remove("payload_json");
        object.remove("checkpoint_json");
        object.insert(
            "detail".to_owned(),
            detail.map(Value::String).unwrap_or(Value::Null),
        );
    }
    Ok(value)
}

/// `job_stats` 的「最近」窗口:24 小时(任务页的「24h 完成 / 失败」两张卡)。
const JOB_RECENT_HOURS: i64 = 24;

/// 参数里的状态名 → 枚举;认不出的报参数错误(不静默忽略,免得筛选条件悄悄失效)。
fn parse_job_state_arg(state: &str) -> Result<JobState> {
    match state {
        "queued" => Ok(JobState::Queued),
        "running" => Ok(JobState::Running),
        "paused" => Ok(JobState::Paused),
        "done" => Ok(JobState::Done),
        "failed" => Ok(JobState::Failed),
        "canceled" => Ok(JobState::Canceled),
        other => Err(KbError::InvalidInput(format!("未知的任务状态 {other}"))),
    }
}

/// 任务序列 → 接口 JSON:每个桶带自己的起点(毫秒),前端直接画。
fn job_series_json(range: &str, series: &kb_core::model::JobSeries) -> Value {
    let buckets: Vec<Value> = series
        .buckets
        .iter()
        .enumerate()
        .map(|(index, bucket)| {
            json!({
                "at": series.start + series.step_ms * index as i64,
                "created": bucket.created,
                "done": bucket.done,
                "failed": bucket.failed,
                "canceled": bucket.canceled,
                "avg_ms": bucket.avg_ms,
                "queue_depth": bucket.queue_depth,
            })
        })
        .collect();
    json!({ "range": range, "start": series.start, "step_ms": series.step_ms, "buckets": buckets })
}

/// 统计结果 → 接口 JSON(字段说明见 `job_stats` 能力)。
fn job_stats_json(stats: &kb_core::model::JobStats) -> Value {
    let by_state: serde_json::Map<String, Value> = stats
        .by_state
        .iter()
        .map(|(state, count)| (state.as_str().to_owned(), json!(count)))
        .collect();
    json!({
        "total": stats.total,
        "by_state": by_state,
        "kinds": stats
            .kinds
            .iter()
            .map(|(kind, count)| json!({ "kind": kind, "count": count }))
            .collect::<Vec<_>>(),
        "recent": {
            "hours": JOB_RECENT_HOURS,
            "since": stats.recent_since,
            "done": stats.recent_done,
            "failed": stats.recent_failed,
            "canceled": stats.recent_canceled,
            "avg_ms": stats.recent_avg_ms,
        },
        "queue": {
            "oldest_queued_at": stats.oldest_queued_at,
            "first_running": stats.first_running.as_ref().map(|(kind, collection)| {
                json!({ "kind": kind, "collection": collection })
            }),
        },
        "durations": {
            "edges_ms": kb_core::model::JOB_DURATION_EDGES_MS,
            "buckets": stats.duration_buckets,
            "count": stats.duration_count,
            "median_ms": stats.duration_median_ms,
            "p95_ms": stats.duration_p95_ms,
        },
    })
}

#[allow(clippy::needless_question_mark)]
impl ServiceBackend {
    pub(super) async fn job_list_impl(&self, args: JobListArgs) -> Result<Value> {
        let mut states = args.states.clone();
        states.extend(args.state.clone());
        let filter = kb_core::model::JobFilter {
            states: states
                .iter()
                .map(|state| parse_job_state_arg(state))
                .collect::<Result<Vec<_>>>()?,
            kinds: args.kinds,
            exclude_kinds: args.exclude_kinds,
            collections: args.collection.into_iter().collect(),
        };
        let (page, page_size) = page_of(args.page, args.page_size);
        let (jobs, total) = JobRepo::list_page(self.rt().meta.as_ref(), filter, page).await?;
        // 列表只给摘要:payload_json / checkpoint_json 是任务的内部状态,索引任务的单条能到几 MB。
        // 也不再一次给全部:生产上 1.4 万个任务整份 4 MB,任务页、仪表盘、项目页每次刷新都整份拉一遍。
        // 完整内容用 job_get 取,统计用 job_stats
        let summaries = jobs.iter().map(job_summary).collect::<Result<Vec<_>>>()?;
        Ok(json!({
            "jobs": summaries,
            "total": total,
            "page": args.page.unwrap_or(1).max(1),
            "page_size": page_size,
        }))
    }

    pub(super) async fn job_stats_impl(
        &self,
        args: kb_capability::defs::JobStatsArgs,
    ) -> Result<Value> {
        let filter = kb_core::model::JobFilter {
            exclude_kinds: args.exclude_kinds,
            collections: args.collection.into_iter().collect(),
            ..kb_core::model::JobFilter::default()
        };
        let now = crate::daemon::now_millis();
        let since = now - JOB_RECENT_HOURS * 3_600_000;
        let runtime = self.rt();
        let meta = runtime.meta.as_ref();
        let stats = JobRepo::stats(meta, filter.clone(), since).await?;
        let mut value = job_stats_json(&stats);
        // 待补向量队列与统计同一次返回:任务页不用再发第二个请求,也避免两处数字不同步。
        // 任务页按 collection 过滤时,队列也只看这一个:不能把别的项目的 collection 名/块数带出去。
        let pending_collection = filter.collections.first().map(String::as_str);
        let pending = crate::pending::overview(meta, pending_collection).await?;
        value["pending"] = serde_json::to_value(&pending)
            .map_err(|err| kb_core::KbError::Internal(format!("序列化待补向量队列失败: {err}")))?;
        // 还要序列(吞吐、排队深度):桶边界按站点时区对齐(默认北京时间)
        if let Some(range) = args.range.as_deref() {
            let offset_ms = kb_core::timezone::offset_millis(now);
            let (start, step, count) =
                kb_capability::defs::job_series_window(range, now, offset_ms).ok_or_else(|| {
                    KbError::InvalidInput(format!("未知的时间范围 {range},可选 24h / 7d / 30d"))
                })?;
            let series = JobRepo::series(meta, filter, start, step, count).await?;
            value["series"] = job_series_json(range, &series);
        }
        Ok(value)
    }

    pub(super) async fn ingest_stats_impl(
        &self,
        args: kb_capability::defs::IngestStatsArgs,
    ) -> Result<Value> {
        const HOUR: i64 = 3_600_000;
        let hours = args.hours.unwrap_or(24).clamp(1, 72) as usize;
        let now = crate::daemon::now_millis();
        // 最后一个桶包含现在
        let start = (now.div_euclid(HOUR) + 1) * HOUR - HOUR * hours as i64;
        let overview = kb_core::ports::repo::ActivityRepo::ingest_overview(
            self.rt().meta.as_ref(),
            start,
            HOUR,
            hours,
            5,
        )
        .await?;
        let buckets: Vec<Value> = overview
            .buckets
            .iter()
            .enumerate()
            .map(|(index, bucket)| json!({ "at": start + HOUR * index as i64, "total": bucket.total, "done": bucket.done, "failed": bucket.failed }))
            .collect();
        Ok(json!({
            "by_state": overview.by_state.iter().map(|(state, count)| json!({ "state": state, "count": count })).collect::<Vec<_>>(),
            "start": start,
            "step_ms": HOUR,
            "buckets": buckets,
            "top_errors": overview.top_errors.iter().map(|(error, count)| json!({ "error": error, "count": count })).collect::<Vec<_>>(),
        }))
    }

    pub(super) async fn project_file_stats_impl(&self) -> Result<Value> {
        let rows =
            kb_core::ports::repo::ActivityRepo::file_status_counts(self.rt().meta.as_ref()).await?;
        let mut collections: Vec<(String, serde_json::Map<String, Value>, u64)> = Vec::new();
        for (collection, status, count) in rows {
            if collections
                .last()
                .is_none_or(|(name, ..)| *name != collection)
            {
                collections.push((collection.clone(), serde_json::Map::new(), 0));
            }
            let last = collections.last_mut().expect("刚放进去");
            last.1.insert(status, json!(count));
            last.2 += count;
        }
        Ok(json!({
            "collections": collections
                .into_iter()
                .map(|(collection, statuses, total)| json!({ "collection": collection, "statuses": statuses, "total": total }))
                .collect::<Vec<_>>(),
        }))
    }

    pub(super) async fn audit_stats_impl(
        &self,
        args: kb_capability::defs::ActivitySeriesArgs,
    ) -> Result<Value> {
        // 页面自动刷新用的读取:次数反映的是页面开了多久,不是谁在用,不进热力和排行
        const POLLING: &[&str] = &[
            "activity_series",
            "acp_agents",
            "audit_list",
            "audit_stats",
            "backup_state",
            "backup_status",
            "batch_list",
            "eval_history",
            "get_config",
            "ingest_stats",
            "job_files",
            "job_list",
            "job_stats",
            "list_collections",
            "list_ingest",
            "list_projects",
            "list_skills",
            "list_sources",
            "llm_providers",
            "llm_usage_series",
            "metrics_series",
            "ocr_status",
            "project_file_stats",
            "provider_list",
            "recommend_providers",
            "stats_overview",
            "system_status",
        ];
        let days = args.days.unwrap_or(30).clamp(1, 90);
        let now = crate::daemon::now_millis();
        let offset_secs = kb_core::timezone::offset_seconds(now);
        let overview = kb_core::ports::repo::ActivityRepo::audit_overview(
            self.rt().meta.as_ref(),
            now - i64::from(days) * 86_400_000,
            offset_secs,
            POLLING.iter().map(|name| (*name).to_owned()).collect(),
            8,
        )
        .await?;
        Ok(json!({
            "days": days,
            "heat": overview.heat,
            "top": overview.top.iter().map(|(capability, count, failed)| json!({ "capability": capability, "count": count, "failed": failed })).collect::<Vec<_>>(),
            "total": overview.total,
            "failed": overview.failed,
        }))
    }

    pub(super) async fn activity_series_impl(
        &self,
        args: kb_capability::defs::ActivitySeriesArgs,
    ) -> Result<Value> {
        let days = args.days.unwrap_or(30).clamp(1, 90);
        let (start, labels) = kb_service::stats::day_window(crate::daemon::now_millis(), days);
        let counts =
            kb_core::ports::repo::ActivityRepo::activity(self.rt().meta.as_ref(), start, labels)
                .await?;
        Ok(json!({
            "days": counts.days,
            "notes": counts.notes,
            "edits": counts.edits,
            "imports": counts.imports,
            "imports_done": counts.imports_done,
            "searches": counts.searches,
            "jobs_done": counts.jobs_done,
            "ai_tokens": counts.ai_tokens,
        }))
    }

    pub(super) async fn job_get_impl(&self, args: JobIdArgs) -> Result<Value> {
        let job = JobRepo::get(self.rt().meta.as_ref(), &args.id)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("job {}", args.id)))?;
        Ok(json!({ "job": job }))
    }

    pub(super) async fn job_files_impl(&self, args: JobFilesArgs) -> Result<Value> {
        // 任务不存在时给 404 而不是空清单:前者是调用方用错了 id,后者是「老任务没记录」,
        // 前端要区别处理(空清单时回退到任务参数里的文件列表)
        let exists = JobRepo::get(self.rt().meta.as_ref(), &args.id).await?;
        if exists.is_none() {
            return Err(KbError::NotFound(format!("job {}", args.id)));
        }
        let (page_arg, page_size) = page_of(args.page, args.page_size);
        let (files, total, counts) =
            JobRepo::list_job_files(self.rt().meta.as_ref(), &args.id, page_arg).await?;
        let counts: serde_json::Map<String, Value> = counts
            .into_iter()
            .map(|(change, n)| (change.as_str().to_owned(), json!(n)))
            .collect();
        Ok(json!({
            "job_id": args.id,
            "total": total,
            "page": page_arg.offset / page_size + 1,
            "page_size": page_size,
            "counts": counts,
            "items": files,
        }))
    }

    pub(super) async fn job_cancel_impl(&self, args: JobIdArgs) -> Result<Value> {
        let job = kb_service::insight::cancel_job(self.rt().meta.as_ref(), &args.id).await?;
        Ok(json!({ "job_id": job.id, "state": job.state.as_str() }))
    }

    pub(super) async fn eval_run_impl(&self, args: EvalRunArgs) -> Result<Value> {
        // `set` 由调用者填:只认自己知识库 eval 目录里的黄金集。绝对路径和 `..` 一律拒绝——
        // 否则它能指到服务器上任意文件(别人的 meta.db、secrets.toml),
        // 而解析失败的报错会把出错那一行的原文带回给调用者。
        // 本机命令行(`kb.sock`)的调用者本来就是这台机器的管理员,黄金集可以放在任何地方(相对 cwd 或绝对路径)。
        let restricted =
            kb_capability::current_principal().is_some_and(|principal| !principal.local);
        let set = match args.set {
            Some(name) if restricted => {
                kb_service::safe_path::check_rel_path(&name)?;
                let path = kb_service::safe_path::resolve_inside(self.rt().paths.eval_dir(), &name)
                    .ok_or_else(|| {
                        KbError::NotFound(format!("黄金集 {name}(只能用 eval 目录里的文件)"))
                    })?;
                Some(path.to_string_lossy().into_owned())
            }
            other => other,
        };
        // 没指定黄金集 = 用本知识库自己的那份,与 `kb eval` / 夜间门禁同一条默认路径
        // (`golden_paths`:KB_HOME/eval/golden.toml 优先,再退回仓库示例集)。
        // 以前这里是空的,`run_inline` 自己退回相对 cwd 的 `eval/golden.example.toml`,
        // 于是 Web 评测页在生产上量的是 7 条演示用例——它们的集合在生产不存在,
        // 页面只会报「全都对不上库」,而 `kb eval` 明明跑得好好的。
        let set = match set {
            Some(path) => std::path::PathBuf::from(path),
            None => crate::commands::eval::golden_paths(self.rt().paths.eval_dir())
                .into_iter()
                .find(|path| path.is_file())
                .ok_or_else(|| {
                    KbError::NotFound(
                        "没有找到黄金集:先写 <KB_HOME>/eval/golden.toml(或在仓库根放 eval/golden.example.toml)"
                            .into(),
                    )
                })?,
        };
        // `--rerank` 三态:on / off / auto(不写 = 按配置)
        let rerank = match args.rerank.as_deref() {
            None | Some("auto") => None,
            Some("on") => Some(true),
            Some("off") => Some(false),
            Some(other) => {
                return Err(KbError::InvalidInput(format!(
                    "rerank 只能是 on / off / auto,收到 {other:?}"
                )));
            }
        };
        let result = crate::commands::eval::run_inline(
            &self.rt().config(),
            self.rt().meta.clone(),
            self.rt().store(),
            self.rt().embedder.clone(),
            &set,
            args.k,
            args.sample,
            args.seed,
            rerank,
        )
        .await?;
        // 历次结果落在 `<KB_HOME>/eval/history.jsonl`(「显示历次结果」)
        if let Err(err) = append_eval_history(self.rt().paths.eval_dir(), &result, None) {
            tracing::warn!(error = %err, "写评测历史失败");
        }
        Ok(result)
    }

    pub(super) async fn eval_history_impl(&self, args: EvalHistoryArgs) -> Result<Value> {
        let limit = args.limit.unwrap_or(20).clamp(1, 100) as usize;
        let runs = read_eval_history(self.rt().paths.eval_dir(), limit)?;
        Ok(json!({ "runs": runs }))
    }

    pub(super) async fn batch_tag_impl(&self, ctx: &CallCtx, args: BatchTagArgs) -> Result<Value> {
        let result = self
            .items()
            .batch_tag(&args.ids, &args.add, &args.remove, ctx.batch_id.as_deref())
            .await?;
        for item in &result.updated {
            self.publish_item_changed("tagged", &item.id, "");
        }
        Ok(serde_json::to_value(result)
            .map_err(|err| KbError::Internal(format!("序列化结果失败: {err}")))?)
    }

    pub(super) async fn stats_overview_impl(&self) -> Result<Value> {
        let overview = self.stats().overview().await?;
        Ok(serde_json::to_value(overview)
            .map_err(|err| KbError::Internal(format!("序列化概览失败: {err}")))?)
    }

    pub(super) async fn refresh_sources_impl(&self, args: RefreshSourcesArgs) -> Result<Value> {
        let now = kb_service::llm_gate::today_now_millis();
        if args.dry_run {
            let due = kb_service::refresh::due_sources(self.rt().meta.as_ref(), now).await?;
            return Ok(json!({
                "dry_run": true,
                "due": due
                    .iter()
                    .map(|source| json!({
                        "id": source.id,
                        "name": source.name,
                        "kind": source.kind.as_str(),
                        "refresh_minutes": source.refresh_minutes,
                        "last_synced_at": source.last_synced_at,
                    }))
                    .collect::<Vec<_>>(),
            }));
        }
        let due = kb_service::refresh::due_sources(self.rt().meta.as_ref(), now).await?;
        let mut report = kb_service::refresh::RefreshReport {
            attempted: due.len() as u64,
            ..kb_service::refresh::RefreshReport::default()
        };
        for source in due {
            match self.sources().sync("web", &source.id).await {
                Ok(outcome) => {
                    report.refreshed += 1;
                    report.queued += outcome.queued;
                }
                Err(err) => report.failed.push((source.name.clone(), err.to_string())),
            }
        }
        Ok(serde_json::to_value(report)
            .map_err(|err| KbError::Internal(format!("序列化刷新结果失败: {err}")))?)
    }

    pub(super) async fn audit_list_impl(&self, args: AuditListArgs) -> Result<Value> {
        let filter = kb_core::model::AuditFilter {
            actor: args.actor,
            capability: args.capability,
            since: args.since,
            batch_id: args.batch_id,
        };
        let (page, _) = page_of(args.page, args.page_size);
        let response = self.web().audit_list(Some(filter), page).await?;
        Ok(serde_json::to_value(response)
            .map_err(|err| KbError::Internal(format!("序列化审计列表失败: {err}")))?)
    }

    pub(super) async fn batch_list_impl(&self, args: PageArgs) -> Result<Value> {
        let (page, _) = page_of(args.page, args.page_size);
        let response = self.web().batch_list(page).await?;
        Ok(serde_json::to_value(response)
            .map_err(|err| KbError::Internal(format!("序列化批次列表失败: {err}")))?)
    }

    // --- :数据源与解析队列 ---

    pub(super) async fn list_sources_impl(&self) -> Result<Value> {
        let sources = self.sources().list().await?;
        // 每个源的解析队列计数(数据源页的「+N 今天 / N 失败 · N 隔离」):
        // 一条 SQL 汇总全部 source_id,再按 id 贴到对应的源上
        let today_start = kb_service::stats::today_start_millis();
        let stats = IngestRepo::stats_by_source(self.rt().meta.as_ref(), today_start).await?;
        let by_source: std::collections::HashMap<&str, &kb_core::model::SourceIngestStats> = stats
            .iter()
            .filter_map(|item| item.source_id.as_deref().map(|id| (id, item)))
            .collect();
        let items: Vec<Value> = sources
            .iter()
            .map(|source| {
                let stat = by_source.get(source.id.as_str());
                json!({
                    "source": source,
                    "stats": stat.map(|stat| json!({
                        "total": stat.total,
                        "today": stat.today,
                        "failed": stat.failed,
                        "quarantined": stat.quarantined,
                        "pending": stat.pending,
                    })),
                })
            })
            .collect();
        // 新建网页来源时「AI 规范化」开关的默认值:普通用户读不到系统参数,添加对话框从这里取
        Ok(json!({
            "sources": sources,
            "items": items,
            "ai_extract_default": self.rt().config().web_extract.enabled_by_default,
        }))
    }

    pub(super) async fn add_source_impl(&self, args: AddSourceArgs) -> Result<Value> {
        // 本机目录和 Git 来源读的是服务器上的路径 / 任意仓库:要 `sources.local`(危险功能,
        // 默认不给普通用户)。网页来源只要 `sources.web`(访问网络,另有内网地址拦截)。
        if matches!(
            kb_core::model::SourceKind::parse(args.kind.trim()),
            Some(kb_core::model::SourceKind::LocalDir | kb_core::model::SourceKind::Git)
        ) {
            require_local_sources()?;
        }
        let source = self
            .sources()
            .add(kb_service::AddSourceRequest {
                kind: Some(args.kind),
                name: args.name,
                uri: args.uri,
                collection: Some(args.collection),
                tags: args.tags,
                include: args.include,
                exclude: args.exclude,
                depth: args.depth,
                allow_hosts: args.allow_hosts,
                refresh_minutes: args.refresh_minutes,
                ai_extract: args.ai_extract,
                extract_prompt: args.extract_prompt,
            })
            .await?;
        Ok(json!({ "source": source }))
    }

    pub(super) async fn update_source_impl(&self, args: UpdateSourceArgs) -> Result<Value> {
        self.require_local_sources_for(&args.id).await?;
        let source = self
            .sources()
            .update(kb_service::UpdateSourceRequest {
                id: args.id,
                name: args.name,
                uri: args.uri,
                collection: args.collection,
                tags: args.tags,
                include: args.include,
                exclude: args.exclude,
                depth: args.depth,
                allow_hosts: args.allow_hosts,
                // 0 表示关掉定时刷新
                refresh_minutes: args
                    .refresh_minutes
                    .map(|value| if value == 0 { None } else { Some(value) }),
                ai_extract: args.ai_extract,
                extract_prompt: args.extract_prompt,
            })
            .await?;
        Ok(json!({ "source": source }))
    }

    pub(super) async fn remove_source_impl(&self, args: ItemIdArgs) -> Result<Value> {
        // 移除本机目录 / Git 来源同样属于「读服务器路径」的后续操作：
        // 权限被收回后，不能靠移除索引来清理痕迹或绕过 sources.local。
        self.require_local_sources_for(&args.id).await?;
        let removed = self.sources().remove(&args.id).await?;
        Ok(serde_json::to_value(removed)
            .map_err(|err| KbError::Internal(format!("序列化结果失败: {err}")))?)
    }

    pub(super) async fn sync_source_impl(&self, ctx: &CallCtx, args: ItemIdArgs) -> Result<Value> {
        self.require_local_sources_for(&args.id).await?;
        let outcome = self.sources().sync(&actor_of(ctx), &args.id).await?;
        if let Some(hub) = &self.hub {
            hub.publish(
                "source.synced",
                json!({
                    "source_id": outcome.source.id,
                    "queued": outcome.queued,
                    "batch_id": outcome.batch_id,
                }),
            );
        }
        Ok(serde_json::to_value(outcome)
            .map_err(|err| KbError::Internal(format!("序列化结果失败: {err}")))?)
    }

    pub(super) async fn list_ingest_impl(&self, args: ListIngestArgs) -> Result<Value> {
        let state = match args.state.as_deref() {
            None => None,
            Some(text) => Some(kb_core::model::IngestState::parse(text).ok_or_else(|| {
                KbError::InvalidInput(format!(
                    "state 只能是 queued / extracting / chunking / embedding / done / failed / quarantined,收到 {text}"
                ))
            })?),
        };
        let (page, _) = page_of(args.page, args.page_size);
        let response = self
            .ingest()
            .list(
                kb_core::model::IngestFilter {
                    collection: args.collection,
                    batch_id: args.batch_id,
                    source_id: None,
                    state,
                },
                page,
            )
            .await?;
        Ok(serde_json::to_value(response)
            .map_err(|err| KbError::Internal(format!("序列化结果失败: {err}")))?)
    }

    pub(super) async fn retry_ingest_impl(&self, args: IngestIdsArgs) -> Result<Value> {
        let report = self.ingest().retry(&args.ids).await?;
        Ok(serde_json::to_value(report)
            .map_err(|err| KbError::Internal(format!("序列化结果失败: {err}")))?)
    }

    pub(super) async fn release_quarantine_impl(&self, args: ItemIdArgs) -> Result<Value> {
        let file = self.ingest().release_quarantine(&args.id).await?;
        Ok(json!({ "file": file }))
    }

    // --- :批次流水线 ---

    pub(super) async fn get_batch_progress_impl(&self, args: BatchArgs) -> Result<Value> {
        let progress = self.batches().progress(&args.batch).await?;
        Ok(serde_json::to_value(progress)
            .map_err(|err| KbError::Internal(format!("序列化进度失败: {err}")))?)
    }

    pub(super) async fn get_file_timeline_impl(&self, args: ItemIdArgs) -> Result<Value> {
        let timeline = self.batches().timeline(&args.id).await?;
        Ok(serde_json::to_value(timeline)
            .map_err(|err| KbError::Internal(format!("序列化时间线失败: {err}")))?)
    }

    pub(super) async fn pause_batch_impl(&self, args: BatchArgs) -> Result<Value> {
        let progress = self.batches().pause(&args.batch).await?;
        self.publish_batch_progress(&progress);
        Ok(serde_json::to_value(progress)
            .map_err(|err| KbError::Internal(format!("序列化进度失败: {err}")))?)
    }

    pub(super) async fn resume_batch_impl(&self, args: BatchArgs) -> Result<Value> {
        let progress = self.batches().resume(&args.batch).await?;
        self.publish_batch_progress(&progress);
        Ok(serde_json::to_value(progress)
            .map_err(|err| KbError::Internal(format!("序列化进度失败: {err}")))?)
    }

    pub(super) async fn cancel_batch_impl(&self, args: BatchArgs) -> Result<Value> {
        // 先撤销(可选)再取消:撤销要读批次里的变更记录,取消会把文件标记为失败
        if args.revert {
            self.reverts().revert(&args.batch).await?;
        }
        let report = self.batches().cancel(&args.batch).await?;
        Ok(serde_json::to_value(report)
            .map_err(|err| KbError::Internal(format!("序列化取消结果失败: {err}")))?)
    }

    pub(super) async fn retry_file_stage_impl(&self, args: RetryStageArgs) -> Result<Value> {
        let stage = match args.stage.as_deref() {
            None => kb_core::model::IngestStage::Extract,
            Some(text) => kb_core::model::IngestStage::parse(text).ok_or_else(|| {
                KbError::InvalidInput(format!(
                    "stage 只能是 upload / detect / extract / chunk / embed / write / searchable,收到 {text}"
                ))
            })?,
        };
        let file = self.batches().retry_stage(&args.id, stage).await?;
        Ok(json!({ "file": file, "from_stage": stage.as_str() }))
    }

    pub(super) async fn skip_file_impl(&self, args: ItemIdArgs) -> Result<Value> {
        let file = self.batches().skip(&args.id).await?;
        Ok(json!({ "file": file }))
    }

    pub(super) async fn quarantine_file_impl(&self, args: ItemIdArgs) -> Result<Value> {
        let file = self.batches().quarantine(&args.id).await?;
        Ok(json!({ "file": file }))
    }
}

/// 追加一条评测历史(`<KB_HOME>/eval/history.jsonl`,一行一条)。
pub(crate) fn append_eval_history(
    dir: &std::path::Path,
    result: &Value,
    gate: Option<&str>,
) -> std::io::Result<()> {
    use std::io::Write;
    std::fs::create_dir_all(dir)?;
    let record = serde_json::json!({
        "at": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or_default(),
        // 设计稿的历次结果表:运行 id / 模式 / hit@10 / hit@3 / MRR / p95 ms
        "run_id": result.get("run_id"),
        // 这一跑用的是哪份黄金集(golden.toml / golden.example.toml):只有文件名,不含路径
        "set": result.get("set"),
        "mode": result.get("mode"),
        "hit_at_1": result.get("hit_at_1"),
        "hit_at_k": result.get("hit_at_k"),
        "hit_at_3": result.get("hit_at_3"),
        "hit_at_10": result.get("hit_at_10"),
        "k": result.get("k"),
        "mrr": result.get("mrr"),
        "p95_ms": result.get("p95_ms"),
        "degraded_cases": result.get("degraded_cases"),
        // 重排的开关与实际覆盖面一起进历史:只看 mode 分不清「配了自动但没装重排器」
        "rerank": result.get("rerank"),
        "reranked_cases": result.get("reranked_cases"),
        "cases": result.get("cases"),
        "by_format": result.get("by_format"),
        // :能不能跟别的一跑比,得看这几项——
        // 用例集同一个指纹、同一个 k,命中率的差才是检索的差。
        "status": result.get("status"),
        "set_hash": result.get("set_hash"),
        "seed": result.get("seed"),
        "sample": result.get("sample"),
        "pool": result.get("pool"),
        "valid_cases": result.get("valid_cases"),
        "invalid_cases": result.get("invalid_cases"),
        "hit_at_k_ci95": result.get("hit_at_k_ci95"),
        // 这条是夜间质量门禁跑出来的;手跑的评测这里是 null
        "gate": gate,
    });
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("history.jsonl"))?;
    writeln!(file, "{record}")
}

/// 读最近 `limit` 条评测历史(新的在前);文件不存在时返回空。
pub(crate) fn read_eval_history(dir: &std::path::Path, limit: usize) -> Result<Vec<Value>> {
    let path = dir.join("history.jsonl");
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => {
            return Err(KbError::Internal(format!(
                "读取 {} 失败: {err}",
                path.display()
            )));
        }
    };
    let mut runs: Vec<Value> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect();
    runs.reverse();
    runs.truncate(limit);
    Ok(runs)
}

#[cfg(test)]
mod job_stats_tests {
    use super::{job_stats_json, parse_job_state_arg};
    use kb_core::model::{JobState, JobStats};

    #[test]
    fn state_names_are_strict() {
        assert_eq!(
            parse_job_state_arg("running").expect("认得"),
            JobState::Running
        );
        assert!(
            parse_job_state_arg("RUNNING").is_err(),
            "大小写不同也不认,免得筛选悄悄失效"
        );
        assert!(parse_job_state_arg("").is_err());
    }

    #[test]
    fn series_json_gives_every_bucket_its_own_start_time() {
        use kb_core::model::{JobBucket, JobSeries};
        let series = JobSeries {
            start: 1_000,
            step_ms: 500,
            buckets: vec![
                JobBucket {
                    created: 2,
                    done: 1,
                    avg_ms: Some(40.0),
                    queue_depth: 3,
                    ..JobBucket::default()
                },
                JobBucket {
                    failed: 1,
                    ..JobBucket::default()
                },
            ],
        };
        let value = super::job_series_json("24h", &series);
        assert_eq!(value["range"], "24h");
        assert_eq!(value["buckets"][0]["at"], 1_000);
        assert_eq!(value["buckets"][1]["at"], 1_500);
        assert_eq!(value["buckets"][0]["queue_depth"], 3);
        assert_eq!(value["buckets"][0]["avg_ms"], 40.0);
        assert_eq!(value["buckets"][1]["avg_ms"], serde_json::Value::Null);
        assert_eq!(value["buckets"][1]["failed"], 1);
    }

    #[test]
    fn stats_json_has_every_state_and_the_window() {
        let stats = JobStats {
            total: 3,
            by_state: vec![(JobState::Queued, 1), (JobState::Done, 2)],
            kinds: vec![("index".to_owned(), 3)],
            recent_since: 42,
            recent_done: 2,
            first_running: Some(("index".to_owned(), None)),
            duration_buckets: vec![1, 1, 0, 0, 0],
            duration_count: 2,
            duration_median_ms: Some(1_500.0),
            ..JobStats::default()
        };
        let value = job_stats_json(&stats);
        assert_eq!(value["by_state"]["queued"], 1);
        assert_eq!(value["by_state"]["done"], 2);
        assert_eq!(value["kinds"][0]["kind"], "index");
        assert_eq!(value["recent"]["hours"], 24);
        assert_eq!(value["recent"]["since"], 42);
        assert_eq!(value["recent"]["avg_ms"], serde_json::Value::Null);
        assert_eq!(value["queue"]["first_running"]["kind"], "index");
        assert_eq!(value["durations"]["edges_ms"][3], 1_800_000);
        assert_eq!(value["durations"]["median_ms"], 1_500.0);
    }
}

#[cfg(test)]
mod job_summary_tests {
    use super::job_summary;
    use kb_core::model::{Job, JobState};

    fn job() -> Job {
        Job {
            id: "j1".to_owned(),
            kind: "index".to_owned(),
            collection: Some("proj_a".to_owned()),
            priority: 0,
            state: JobState::Done,
            payload_json: "x".repeat(10_000),
            checkpoint_json: Some("y".repeat(10_000)),
            detail: None,
            progress_done: 3,
            progress_total: Some(3),
            rate: None,
            error: None,
            created_at: 1,
            started_at: Some(2),
            finished_at: Some(3),
        }
    }

    #[test]
    fn summary_drops_internal_state_but_keeps_everything_the_pages_show() {
        let summary = job_summary(&job()).expect("序列化");
        let object = summary.as_object().expect("对象");
        assert!(
            !object.contains_key("payload_json"),
            "内部状态不该出现在列表里"
        );
        assert!(!object.contains_key("checkpoint_json"));
        for key in [
            "id",
            "kind",
            "collection",
            "state",
            "progress_done",
            "progress_total",
            "rate",
            "error",
            "created_at",
            "started_at",
            "finished_at",
        ] {
            assert!(object.contains_key(key), "缺少 {key}");
        }
        assert_eq!(summary["id"], "j1");
        assert_eq!(summary["state"], "done");
        assert!(summary.get("detail").is_some());
        assert!(
            summary.to_string().len() < 500,
            "摘要应该很小,实际 {} 字节",
            summary.to_string().len()
        );
    }

    #[test]
    fn summary_extracts_detail_for_various_job_payloads() {
        let mut j = job();
        j.payload_json = serde_json::json!({
            "mode": "incremental",
            "paths": ["crates/kb-cli/src/main.rs"]
        })
        .to_string();
        let s = job_summary(&j).expect("ok");
        assert_eq!(s["detail"], "crates/kb-cli/src/main.rs");

        j.payload_json = serde_json::json!({
            "mode": "incremental",
            "paths": ["a.rs", "b.rs", "c.rs"]
        })
        .to_string();
        let s = job_summary(&j).expect("ok");
        assert_eq!(s["detail"], "3 个文件 (a.rs 等)");

        j.payload_json = serde_json::json!({
            "mode": "full",
            "paths": []
        })
        .to_string();
        let s = job_summary(&j).expect("ok");
        assert_eq!(s["detail"], "全量索引");

        j.payload_json = serde_json::json!({
            "insight_id": "in_abc123"
        })
        .to_string();
        let s = job_summary(&j).expect("ok");
        assert_eq!(s["detail"], "笔记 in_abc123");
    }

    /// 列表查询把 payload 置空、由存储层算好 `detail`:这条详情不能在序列化时丢掉。
    /// 丢掉的表现就是任务页「详情」列整列空白,「N 个文件」入口也点不到。
    #[test]
    fn summary_keeps_detail_computed_by_the_repository() {
        let mut j = job();
        j.payload_json = String::new();
        j.detail = Some("3 个文件 (a.rs 等)".to_owned());
        let s = job_summary(&j).expect("ok");
        assert_eq!(s["detail"], "3 个文件 (a.rs 等)");

        j.detail = None;
        let s = job_summary(&j).expect("ok");
        assert!(s["detail"].is_null(), "没有详情时给 null,不是空字符串");
    }
}
