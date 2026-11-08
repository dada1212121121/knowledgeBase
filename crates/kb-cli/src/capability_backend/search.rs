//! 检索:查询、深搜、索引统计与维护、检索质量。

use crate::capability_backend::*;

/// 日志里的查询指纹:不落查询原文(隐私),只留 8 位十六进制,
/// 够把同一条查询的多次调用串起来看趋势。
fn query_fingerprint(query: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    query.hash(&mut hasher);
    format!("{:08x}", (hasher.finish() & 0xffff_ffff) as u32)
}

#[allow(clippy::needless_question_mark)]
impl ServiceBackend {
    pub(super) async fn search_impl(&self, ctx: &CallCtx, args: SearchArgs) -> Result<Value> {
        let started = std::time::Instant::now();
        let collections = self.resolve_scope(ctx, &args).await?;
        let mut query = args.query.clone();
        // 查询串里已经写了 `kind:` 时以它为准(结构化 kinds 参数只是默认值,不能反过来
        // 把用户写的前缀稀释成“多种都要”)。
        let has_kind_prefix = query
            .split_whitespace()
            .any(|token| token.starts_with("kind:") && token.len() > "kind:".len());
        if !has_kind_prefix {
            for kind in &args.kinds {
                query.push_str(&format!(" kind:{kind}"));
            }
        }
        if let Some(lang) = &args.lang {
            query.push_str(&format!(" lang:{lang}"));
        }
        if let Some(prefix) = &args.path_prefix {
            query.push_str(&format!(" path:{prefix}"));
        }
        let service = self.search_service();
        let response = if args.enhance {
            // 查询增强:LLM 改写 + 多查询合并(失败自动退回单查询)
            let enhancer = kb_service::query_enhance::QueryEnhancer::new(
                self.llm_gate(),
                self.chat_model().await?,
            );
            let queries = enhancer
                .enhance(self.project_id_of(&collections).await.as_deref(), &query)
                .await;
            kb_service::query_enhance::search_many(
                &service,
                &queries,
                collections.clone(),
                args.k.unwrap_or(5),
            )
            .await?
        } else {
            service
                .search(SearchRequest {
                    query,
                    collections,
                    k: args.k,
                    explain: args.explain,
                    rerank: args.rerank,
                })
                .await?
        };
        // 一次 info 记录检索形状:出问题时不用复现就能看出「几个集合 / 是否降级 / 重排有没有生效」。
        // 累计耗时看 audit.took_ms(迁移 0020),这一行只解决「这一次发生了什么」。
        tracing::info!(
            query_hash = %query_fingerprint(&args.query),
            collections = response.scope.len(),
            hits = response.hits.len(),
            degraded = response.degraded.as_deref().unwrap_or("-"),
            reranked = response.reranked,
            took_ms = started.elapsed().as_millis() as u64,
            "检索完成"
        );
        Ok(json!({
            "hits": response.hits,
            "scope": response.scope,
            "query_parsed": response.query_parsed,
            "degraded": response.degraded,
            // explain 才有; 的排队时间(`queue_ms`)只在这里能看见,别再算完就丢
            "timings": response.timings,
        }))
    }

    pub(super) async fn reindex_project_impl(&self, args: ReindexArgs) -> Result<Value> {
        let job = self
            .insight()
            .reindex(ReindexRequest {
                project: args.project,
                mode: args.mode,
                paths: args.paths,
                phase: args.phase,
                stop_after_text: args.stop_after_text,
            })
            .await?;
        Ok(json!({ "job_id": job }))
    }

    pub(super) async fn dedup_insights_impl(&self, args: DedupArgs) -> Result<Value> {
        let plan = self
            .dedup()
            .dedup(&args.collection, args.dry_run, "web")
            .await?;
        Ok(serde_json::to_value(plan)
            .map_err(|err| KbError::Internal(format!("序列化去重计划失败: {err}")))?)
    }

    pub(super) async fn tune_retrieval_impl(&self, args: TuneRetrievalArgs) -> Result<Value> {
        let options = kb_service::TuneOptions {
            min_samples: args.min_samples.unwrap_or(5).clamp(1, 1_000),
            // 单次调权幅度不超过 ±0.2
            max_delta: args.max_delta.unwrap_or(0.2).clamp(0.01, 0.2),
            ..kb_service::TuneOptions::default()
        };
        let tuning = kb_service::FeedbackTuning::new(self.rt().meta.clone(), self.rt().store())
            .with_options(options.clone());
        let current = self.rt().config();
        let plan = tuning.plan(&current.search.collection_weights).await?;
        let mut value = serde_json::to_value(&plan)
            .map_err(|err| KbError::Internal(format!("序列化调权计划失败: {err}")))?;
        if args.dry_run || plan.suggestions.is_empty() {
            return Ok(value);
        }

        // 应用:把建议合并进 `search.collection_weights`,走与 Web 改配置同一条路径
        let previous = current.search.collection_weights.clone();
        let mut weights = previous.clone();
        for suggestion in &plan.suggestions {
            weights.insert(suggestion.collection.clone(), suggestion.suggested);
        }
        // 回滚补丁:本次新增的键要显式置 `null`(update_config 是合并语义,不删键就撤不掉,)
        let mut rollback = serde_json::Map::new();
        for suggestion in &plan.suggestions {
            match previous.get(&suggestion.collection) {
                Some(weight) => {
                    rollback.insert(suggestion.collection.clone(), json!(weight));
                }
                None => {
                    rollback.insert(suggestion.collection.clone(), Value::Null);
                }
            }
        }

        let before = self.eval_snapshot().await;
        self.web()
            .update_config(json!({ "search": { "collection_weights": weights } }))
            .await?;
        self.reload_config_now().await;
        let after = self.eval_snapshot().await;

        // 指标下降就回滚。只有“两次评测都跑成功、都没有降级、且 MRR 下降”才回滚:
        // 嵌入器在两次评测之间降级会把 MRR 拉低,那不是权重的问题。
        let snapshot = |result: &Result<Option<Value>>| result.as_ref().ok().cloned().flatten();
        let before_snapshot = snapshot(&before);
        let after_snapshot = snapshot(&after);
        let usable = |value: &Option<Value>| {
            value
                .as_ref()
                .is_some_and(|value| value.get("degraded_cases").and_then(Value::as_u64) == Some(0))
        };
        // :两次必须是同一道题(同一个用例集指纹)才谈得上下降,否则回滚的是用例的差
        let same_set = {
            let hash_of = |value: &Option<Value>| {
                value
                    .as_ref()
                    .and_then(|value| value.get("set_hash"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            };
            matches!((hash_of(&before_snapshot), hash_of(&after_snapshot)), (Some(before_hash), Some(after_hash)) if before_hash == after_hash)
        };
        let mrr_of = |snapshot: &Option<Value>| {
            snapshot
                .as_ref()
                .and_then(|value| value.get("mrr"))
                .and_then(Value::as_f64)
        };
        let rolled_back = usable(&before_snapshot)
            && usable(&after_snapshot)
            && same_set
            && matches!(
                (mrr_of(&before_snapshot), mrr_of(&after_snapshot)),
                (Some(before_mrr), Some(after_mrr)) if after_mrr + 1e-9 < before_mrr
            );
        if rolled_back {
            self.web()
                .update_config(json!({ "search": { "collection_weights": rollback } }))
                .await?;
            self.reload_config_now().await;
        }

        if let Some(object) = value.as_object_mut() {
            object.insert("applied".to_owned(), json!(!rolled_back));
            object.insert("rolled_back".to_owned(), json!(rolled_back));
            object.insert(
                "weights".to_owned(),
                serde_json::to_value(if rolled_back { previous } else { weights })
                    .unwrap_or(Value::Null),
            );
            object.insert(
                "eval".to_owned(),
                json!({
                    "before": before_snapshot,
                    "after": after_snapshot,
                    "before_error": before.as_ref().err().map(|err| err.to_string()),
                    "after_error": after.as_ref().err().map(|err| err.to_string()),
                }),
            );
            let mut notes = Vec::new();
            if rolled_back {
                notes.push("应用后 MRR 下降,已回滚到原来的权重".to_owned());
            }
            if before_snapshot.is_none() && before.as_ref().ok().is_some() {
                notes.push(
                    "没有找到黄金集(<KB_HOME>/eval/golden.toml 或仓库 eval/golden.example.toml),权重已直接应用、没有做前后对比"
                        .to_owned(),
                );
            }
            if before.as_ref().is_err() || after.as_ref().is_err() {
                notes.push("评测没有跑成功,未做回滚判定(只应用了权重)".to_owned());
            } else if before_snapshot.is_some()
                && after_snapshot.is_some()
                && (!usable(&before_snapshot) || !usable(&after_snapshot))
            {
                // 只有“两次都跑出了结果、但其中有降级”才说降级;没有黄金集是 `None`,不能混为一谈
                notes.push(
                    "评测处于降级状态(嵌入器不可用),MRR 不可比,未做回滚判定(只应用了权重)"
                        .to_owned(),
                );
            }
            if !notes.is_empty() {
                object.insert("notes".to_owned(), json!(notes));
            }
        }
        Ok(value)
    }

    pub(super) async fn quality_report_impl(&self, args: QualityReportArgs) -> Result<Value> {
        let report = self.dedup().quality_report(&args.collection).await?;
        Ok(serde_json::to_value(report)
            .map_err(|err| KbError::Internal(format!("序列化质量报告失败: {err}")))?)
    }

    pub(super) async fn consolidate_project_impl(&self, args: ConsolidateArgs) -> Result<Value> {
        let project = self.rt().projects().resolve(&args.project).await?;
        // 归纳与审核各取一个模型实例(无 key 时都是 mock,卡片允许无 key 只做 mock 验收)
        let extract_model = self.rt().config().llm.extract_model.clone();
        let review_name = self.rt().config().llm.review_model.clone();
        let model = self.chat_model_for(&extract_model).await?;
        let review_model = self.chat_model_for(&review_name).await?;
        let service = kb_service::evolution::ConsolidateService::new(
            self.rt().meta.clone(),
            self.rt().store.clone(),
            self.rt().embedder.clone(),
            self.llm_gate(),
            model,
            review_model,
            self.rt().config().evolution.clone(),
        )
        .with_skills(self.rt().skills());
        let report = service.run(&project.id, args.dry_run, "web").await?;
        Ok(serde_json::to_value(report)
            .map_err(|err| KbError::Internal(format!("序列化归纳报告失败: {err}")))?)
    }

    pub(super) async fn index_stats_impl(&self) -> Result<Value> {
        let runtime = self.rt();
        let threshold = runtime.config().index.vector_index_min_rows;
        // 表名 → 集合名:一张表可能被历史记录引用,只认当前 active_table
        let collections = CollectionRepo::list(runtime.meta.as_ref()).await?;
        let mut owners = std::collections::HashMap::new();
        for collection in &collections {
            owners.insert(collection.active_table.clone(), collection.name.clone());
        }
        let mut tables = runtime.store.table_stats().await?;
        // 行数大的排前面:诊断时第一眼要看的就是那几张最贵的表
        // 行数多的表先看:没建索引的代价与行数成正比
        tables.sort_by_key(|table| std::cmp::Reverse(table.rows));
        let rows: Vec<Value> = tables
            .iter()
            .map(|stats| {
                json!({
                    "table": stats.table,
                    "collection": owners.get(&stats.table).cloned(),
                    "rows": stats.rows,
                    "fragments": stats.fragments,
                    "data_files": stats.data_files,
                    "version": stats.version,
                    "versions": stats.versions,
                    "index_kind": stats.index_kind,
                    "index_rows": stats.index_rows,
                    "index_unindexed_rows": stats.index_unindexed_rows,
                    "index_created_at": stats.index_created_at,
                    // 超过阈值却没有索引:夜间任务本该建上,没建上就是需要人看一眼
                    "missing_vector_index": stats.rows >= threshold && stats.index_kind.is_none(),
                })
            })
            .collect();
        Ok(json!({
            "threshold": threshold,
            "tables": rows,
        }))
    }

    pub(super) async fn maintain_indexes_impl(&self, args: MaintainIndexesArgs) -> Result<Value> {
        // 建索引 / 整理会按表串行拿 `optimize_lock`,期间这张表的写入排队,
        // 所以要求显式确认(和 `update_config` 的管理级动作同级待遇)
        if !args.confirm {
            return Err(KbError::InvalidInput(
                "整理索引会短暂占住表的写入,请带 confirm: true 再执行".to_owned(),
            ));
        }
        let runtime = self.rt();
        let service = kb_service::index::IndexService::new(
            runtime.meta.clone(),
            runtime.store.clone(),
            runtime.embedder.clone(),
            runtime.chunker.clone(),
            runtime.scanner.clone(),
            kb_service::index::IndexOptions::from_config(&runtime.config()),
        );
        let wanted: std::collections::HashSet<&str> =
            args.collections.iter().map(String::as_str).collect();
        let mut done = Vec::new();
        let mut failed = Vec::new();
        for collection in CollectionRepo::list(runtime.meta.as_ref()).await? {
            if !wanted.is_empty() && !wanted.contains(collection.name.as_str()) {
                continue;
            }
            // 先建索引再整理:optimize 会把新行并进已有索引
            match service.ensure_indexes(&collection).await {
                Ok(()) => match service.optimize(&collection).await {
                    Ok(()) => done.push(collection.name.clone()),
                    Err(err) => failed.push(json!({
                        "collection": collection.name,
                        "stage": "optimize",
                        "error": err.to_string(),
                    })),
                },
                Err(err) => failed.push(json!({
                    "collection": collection.name,
                    "stage": "index",
                    "error": err.to_string(),
                })),
            }
        }
        Ok(json!({ "maintained": done, "failed": failed }))
    }

    pub(super) async fn deep_search_impl(
        &self,
        ctx: &CallCtx,
        args: DeepSearchArgs,
    ) -> Result<Value> {
        // 作用域解析与 search 共用同一套规则,这里借一个等价参数
        let scope_args = SearchArgs {
            query: args.question.clone(),
            scope: args.scope.clone(),
            project: args.project.clone(),
            kinds: Vec::new(),
            k: None,
            rerank: None,
            explain: false,
            enhance: false,
            lang: None,
            path_prefix: None,
        };
        let collections = self.resolve_scope(ctx, &scope_args).await?;
        let model = self.chat_model().await?;
        let gate = self.llm_gate();
        let service = self.search_service();
        let rt = self.rt();
        let deep = kb_service::query_enhance::DeepSearch::new(
            &gate,
            model,
            &service,
            rt.store(),
            rt.meta.as_ref(),
            collections,
        );
        let result = deep
            .run(self.project_id_of(&[]).await.as_deref(), &args.question)
            .await?;
        Ok(serde_json::to_value(result)
            .map_err(|err| KbError::Internal(format!("序列化深度检索结果失败: {err}")))?)
    }
}

impl ServiceBackend {
    /// 巩固服务(去重 / 质量报告)。
    pub(crate) fn dedup(&self) -> kb_service::evolution::DedupService {
        kb_service::evolution::DedupService::new(
            self.rt().meta.clone(),
            self.rt().embedder.clone(),
            self.rt().config().evolution.clone(),
        )
    }
}
