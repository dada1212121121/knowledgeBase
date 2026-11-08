//! 条目:insight 与 item 的读写、状态与历史、批注。

use crate::capability_backend::*;

#[allow(clippy::needless_question_mark)]
impl ServiceBackend {
    pub(super) async fn get_item_impl(&self, args: GetItemArgs) -> Result<Value> {
        // insight 以 SQLite 为准:`save_insight` / `edit_item` 同步写库、异步重嵌入,
        // 只读 LanceDB 会出现“刚保存就 404”“刚改完还是旧标题”。
        if let Some(insight) = InsightRepo::get(self.rt().meta.as_ref(), &args.id).await? {
            let collection = CollectionRepo::get(self.rt().meta.as_ref(), &insight.collection)
                .await?
                .ok_or_else(|| KbError::NotFound(format!("collection {}", insight.collection)))?;
            let embedded = self
                .rt()
                .store()
                .get(&collection.active_table, std::slice::from_ref(&args.id))
                .await?
                .into_iter()
                .next();
            // 还没嵌入(刚保存)或库里的副本比 SQLite 旧(刚改过)时,用库里的权威内容回答
            let pending = embedded
                .as_ref()
                .map(|row| insight.updated_at > row.updated_at)
                .unwrap_or(true);
            let item = if pending {
                kb_service::insight::insight_row(&insight, &collection.embedder_id)
            } else {
                embedded.expect("pending=false 时一定有 LanceDB 行")
            };
            return Ok(json!({
                "item": item,
                // 客户端保存时要带上乐观锁版本:详情里没有的话,前端只能拿列表里的版本,
                // 列表被筛选掉 / 按链接直接打开时就拿不到,保存必然撞版本冲突
                "version": insight.version,
                "context": Value::Null,
                "pending_embedding": pending,
            }));
        }
        let collection = self.collection_of(&args.id).await?;
        let rows = self
            .rt()
            .store()
            .get(&collection.active_table, std::slice::from_ref(&args.id))
            .await?;
        let row = rows
            .into_iter()
            .next()
            .ok_or_else(|| KbError::NotFound(format!("item {}", args.id)))?;
        // 上下文:项目内代码块按源文件补上下文行(设计规范的 get_item.context)
        let context = match (args.context_lines, &collection.project_id) {
            (Some(lines), Some(_)) => {
                context_lines_of(self.rt().meta.as_ref(), &collection, &row, lines).await
            }
            _ => None,
        };
        Ok(json!({ "item": row, "context": context }))
    }

    pub(super) async fn item_facets_impl(&self, args: ItemFacetsArgs) -> Result<Value> {
        let statuses = match args.status.as_deref() {
            None | Some("active") => vec![ItemStatus::Active],
            Some("superseded") => vec![ItemStatus::Superseded],
            Some("deprecated") => vec![ItemStatus::Deprecated],
            Some("all") => ItemStatus::ALL.to_vec(),
            Some(other) => {
                return Err(KbError::InvalidInput(format!(
                    "status 只能是 active / superseded / deprecated / all,收到 {other}"
                )));
            }
        };
        // 按文件计数:和浏览器列表(按文件列)的总数对得上,同一份文档的几十个块只算一个
        let (counts, dirs) = self
            .items()
            .count_files_by_kind_dir(&args.collection, &statuses)
            .await?;
        let kinds: Vec<Value> = ["code", "doc", "insight"]
            .iter()
            .filter_map(|name| {
                counts
                    .iter()
                    .find(|(kind, _, _)| kind.as_str() == *name)
                    .map(|(_, count, dirs)| {
                        let dirs: Vec<Value> = dirs
                            .iter()
                            .map(|(dir, count)| json!({ "dir": dir, "count": count }))
                            .collect();
                        json!({ "kind": name, "count": count, "dirs": dirs })
                    })
            })
            .collect();
        Ok(json!({ "kinds": kinds, "dirs": dirs }))
    }

    pub(super) async fn import_global_impl(&self, args: ImportGlobalArgs) -> Result<Value> {
        let path = std::path::PathBuf::from(&args.path);
        if !path.exists() {
            return Err(KbError::InvalidInput(format!("{} 不存在", path.display())));
        }
        let global = self.rt().collections().ensure_global().await?;
        let report = self
            .rt()
            .index_service()
            .index_global_path(&global, &path, &args.tags)
            .await?;
        Ok(json!({
            "scanned": report.scanned,
            "chunks": report.chunks,
            "embedded": report.embedded,
            "errors": report.errors,
        }))
    }

    pub(super) async fn save_insight_impl(
        &self,
        ctx: &CallCtx,
        args: SaveInsightArgs,
    ) -> Result<Value> {
        self.ensure_room(args.title.len() + args.body.len()).await?;
        let kind = match args.kind.as_deref() {
            Some("decision") => kb_core::model::InsightKind::Decision,
            Some("pitfall") => kb_core::model::InsightKind::Pitfall,
            Some("howto") => kb_core::model::InsightKind::Howto,
            Some("convention") => kb_core::model::InsightKind::Convention,
            Some("note") | None => kb_core::model::InsightKind::Note,
            Some(other) => {
                return Err(KbError::InvalidInput(format!("未知的 kind {other}")));
            }
        };
        let created_by = insight_author(ctx);
        let body_for_links = args.body.clone();
        let saved = self
            .insight()
            .save(SaveInsightRequest {
                title: args.title,
                body_md: args.body,
                kind: Some(kind),
                project: args.project.or_else(|| ctx.project.clone()),
                collection: args.collection,
                global: args.global,
                tags: args.tags,
                related_paths: args.related_paths,
                supersedes: args.supersedes,
                strict_links: args.strict_links,
                created_by,
                cwd: ctx.cwd.clone(),
            })
            .await?;
        let links =
            kb_service::doc_links::parse_doc_links(&body_for_links, &saved.collection, None);
        Ok(json!({
            "id": saved.id,
            "version": saved.version,
            "collection": saved.collection,
            "job_id": saved.job_id,
            "links": links.iter().map(parsed_link_json).collect::<Vec<_>>(),
        }))
    }

    pub(super) async fn kb_feedback_impl(&self, args: FeedbackArgs) -> Result<Value> {
        let id = self
            .insight()
            .feedback(FeedbackRequest {
                query: args.query,
                item_id: args.item_id,
                useful: args.useful,
                note: args.note,
                source: "mcp".to_owned(),
            })
            .await?;
        Ok(json!({ "id": id }))
    }

    pub(super) async fn set_item_status_impl(&self, args: SetStatusArgs) -> Result<Value> {
        let status = match args.status.as_str() {
            "active" => ItemStatus::Active,
            "superseded" => ItemStatus::Superseded,
            "deprecated" => ItemStatus::Deprecated,
            other => {
                return Err(KbError::InvalidInput(format!("未知的状态 {other}")));
            }
        };
        let insight = self.insight().set_status(&args.id, status).await?;
        Ok(
            json!({ "id": insight.id, "status": insight.status.as_str(), "version": insight.version }),
        )
    }

    pub(super) async fn supersede_insight_impl(&self, args: SupersedeArgs) -> Result<Value> {
        let insight = self.insight().supersede(&args.old_id, &args.new_id).await?;
        Ok(json!({ "id": insight.id, "status": insight.status.as_str() }))
    }

    pub(super) async fn item_history_impl(&self, args: ItemIdArgs) -> Result<Value> {
        let chain = self.insight().history(&args.id).await?;
        Ok(json!({ "items": chain }))
    }

    // --- :Web 管理端 ---

    pub(super) async fn list_items_impl(&self, args: ListItemsArgs) -> Result<Value> {
        // `insight_kind` 兼容两种写法:记录种类(code/doc/insight)或 insight 子类型
        // (decision/pitfall/…)。浏览器页的树形导航把两者都塞在这个字段里。
        let mut kind = match args.kind.as_deref() {
            Some(name) => Some(parse_record_kind(name)?),
            None => None,
        };
        let mut insight_kind = None;
        if let Some(name) = args.insight_kind.as_deref() {
            match name {
                "code" | "doc" | "insight" | "external" | "summary" => {
                    kind = Some(parse_record_kind(name)?);
                }
                other => insight_kind = Some(parse_insight_kind(other)?),
            }
        }
        let statuses = match args.status.as_deref() {
            None | Some("active") => vec![ItemStatus::Active],
            Some("superseded") => vec![ItemStatus::Superseded],
            Some("deprecated") => vec![ItemStatus::Deprecated],
            Some("all") => ItemStatus::ALL.to_vec(),
            Some(other) => {
                return Err(KbError::InvalidInput(format!(
                    "status 只能是 active / superseded / deprecated / all,收到 {other}"
                )));
            }
        };
        let response = self
            .items()
            .list(kb_service::ListRequest {
                collection: args.collection,
                kind,
                insight_kind,
                statuses,
                path_prefix: args.path_prefix,
                tag: args.tag,
                q: args.q,
                page: args.page.unwrap_or(1),
                page_size: args.page_size.unwrap_or(50),
                sort: args.sort,
                ascending: matches!(args.order.as_deref(), Some("asc") | Some("ascending")),
                group_by_file: args.group_by_file,
            })
            .await?;
        Ok(serde_json::to_value(response)
            .map_err(|err| KbError::Internal(format!("序列化列表失败: {err}")))?)
    }

    pub(super) async fn edit_item_impl(&self, ctx: &CallCtx, args: EditItemArgs) -> Result<Value> {
        let kind = match args.kind.as_deref() {
            Some(name) => Some(parse_insight_kind(name)?),
            None => None,
        };
        // 只改标题 / 标签 / 种类不碰协作中的正文;改正文才要避让在线编辑的人:
        // 脚本得到 409;AI 的改动变成一条建议评论,不丢也不覆盖别人正在写的内容
        if let (Some(body), Some(key)) = (args.body.as_deref(), self.insight_key(&args.id).await)
            && let Some(hub) = self.collab.get()
        {
            let busy = hub.is_busy(&key.to_string()).await;
            match busy_policy(&ctx.actor, ctx.client.as_deref(), busy) {
                BusyPolicy::Proceed => {}
                BusyPolicy::Refuse => self.refuse_while_collaborating(Ok(key)).await?,
                BusyPolicy::Suggest => {
                    let insight = InsightRepo::get(self.rt().meta.as_ref(), &args.id)
                        .await?
                        .ok_or_else(|| KbError::NotFound(format!("item {}", args.id)))?;
                    let annotation = self
                        .annotations()
                        .add(kb_service::annotation::AddAnnotationRequest {
                            collection: insight.collection.clone(),
                            source: format!("insight:{}", args.id),
                            anchor: None,
                            body: suggestion_text(body),
                            author: self.actor_label(),
                            parent_id: None,
                            mentions: Vec::new(),
                        })
                        .await?;
                    return Ok(json!({
                        "id": args.id,
                        "suggested": true,
                        "annotation_id": annotation.id,
                        "message": "这篇文档正在被多人编辑,没有直接修改;你的改动已作为建议评论留在文档上,等协作的人决定。",
                    }));
                }
            }
        }
        let written_key = if args.body.is_some() {
            self.insight_key(&args.id).await
        } else {
            None
        };
        let result = self
            .items()
            .edit(
                kb_service::EditRequest {
                    id: args.id,
                    version: args.version,
                    title: args.title,
                    body: args.body,
                    tags: args.tags,
                    kind,
                    author: Some(self.actor_label()),
                },
                ctx.batch_id.as_deref(),
            )
            .await?;
        self.publish_item_changed("edited", &result.id, &result.collection);
        self.tell_collab_of_external_write(written_key).await;
        Ok(json!({
            "id": result.id,
            "version": result.version,
            "collection": result.collection,
            "job_id": result.job_id,
        }))
    }

    pub(super) async fn create_item_impl(
        &self,
        ctx: &CallCtx,
        args: CreateItemArgs,
    ) -> Result<Value> {
        self.ensure_room(args.title.len() + args.body.len()).await?;
        let kind = match args.kind.as_deref() {
            Some(name) => Some(parse_insight_kind(name)?),
            None => None,
        };
        let saved = self
            .items()
            .create(
                kb_service::CreateRequest {
                    collection: args.collection,
                    project: args.project.or_else(|| ctx.project.clone()),
                    global: args.global,
                    title: args.title,
                    body: args.body,
                    kind,
                    tags: args.tags,
                    related_paths: args.related_paths,
                    created_by: actor_of(ctx),
                    cwd: ctx.cwd.clone(),
                },
                ctx.batch_id.as_deref(),
            )
            .await?;
        self.publish_item_changed("created", &saved.id, &saved.collection);
        Ok(json!({
            "id": saved.id,
            "version": saved.version,
            "collection": saved.collection,
            "job_id": saved.job_id,
        }))
    }

    pub(super) async fn delete_item_impl(&self, ctx: &CallCtx, args: ItemIdArgs) -> Result<Value> {
        if let Some(key) = self.insight_key(&args.id).await {
            self.refuse_while_collaborating(Ok(key)).await?;
        }
        let result = self
            .items()
            .delete(&args.id, ctx.batch_id.as_deref())
            .await?;
        self.publish_item_changed("deleted", &result.id, &result.collection);
        if let Some(guard) = &self.storage_guard {
            guard.invalidate(&self.call_space_id());
        }
        if result.insight {
            // 笔记没了:它上面的授权、停止继承、分享链接一起清掉,别留下指向空气的权限
            self.forget_shares(kb_core::share::ResourceKey::insight(
                &self.call_space_id(),
                &result.collection,
                &result.id,
            ))
            .await;
        }
        Ok(json!({
            "id": result.id,
            "collection": result.collection,
            "insight": result.insight,
        }))
    }

    pub(super) async fn add_annotation_impl(&self, args: AddAnnotationArgs) -> Result<Value> {
        let anchor = args
            .anchor
            .map(serde_json::from_value::<kb_core::model::Anchor>)
            .transpose()
            .map_err(|err| KbError::InvalidInput(format!("anchor 不合法: {err}")))?;
        let author = self.actor_label();
        // 游客可以评论,但不能 @ 人:@ 要查用户名,放开会变成枚举用户的办法,也能拿通知刷屏
        let is_guest = author.starts_with("guest:");
        let me = (author.starts_with("usr_")).then(|| author.clone());
        let space = self.call_space_id();
        let directory = self.comments.get().cloned();
        let (collection, source) = (args.collection.clone(), args.source.clone());

        // 只通知「存在、账号可用、并且能看到这篇文档」的人;其余的静默忽略
        let mut mentioned: Vec<String> = Vec::new();
        if let Some(directory) = &directory
            && !is_guest
            && !args.mentions.is_empty()
        {
            for target in directory.resolve_mentions(&args.mentions).await {
                if Some(&target.user_id) != me.as_ref()
                    && directory
                        .can_view(&target.user_id, &space, &collection, &source)
                        .await
                {
                    mentioned.push(target.user_id);
                }
            }
        }
        // 回复要通知被回复的人:先把他是谁取出来(写入之后父评论还在,但取在前面更清楚)
        let parent_author = match &args.parent_id {
            Some(parent_id) => {
                kb_core::ports::repo::AnnotationRepo::get(self.rt().meta.as_ref(), parent_id)
                    .await?
                    .and_then(|parent| parent.author)
            }
            None => None,
        };
        let annotation = self
            .annotations()
            .add(kb_service::annotation::AddAnnotationRequest {
                collection: args.collection,
                source: args.source,
                anchor,
                body: args.body,
                author,
                parent_id: args.parent_id,
                mentions: mentioned,
            })
            .await?;

        if let (Some(directory), false) = (&directory, is_guest) {
            let key = crate::comment_backend::document_key(&space, &collection, &source);
            let snippet: String = annotation.body.chars().take(80).collect();
            // 通知要能直接写成人话:谁(资料对象,和好友通知同一个形状)、哪份文档
            let from = match &me {
                Some(id) => directory
                    .profiles(std::slice::from_ref(id))
                    .await
                    .remove(id),
                None => None,
            };
            let title = match source.strip_prefix("insight:") {
                Some(id) => InsightRepo::get(self.rt().meta.as_ref(), id)
                    .await
                    .ok()
                    .flatten()
                    .map(|insight| insight.title),
                None => source.rsplit('/').next().map(str::to_owned),
            };
            let payload = |kind_note: &str| {
                json!({
                    "key": key.as_ref().map(ToString::to_string),
                    "target": key.as_ref().map(kb_core::share::ResourceKey::to_target),
                    "collection": collection,
                    "source": source,
                    "annotation_id": annotation.id,
                    "parent_id": annotation.parent_id,
                    "snippet": snippet,
                    "excerpt": snippet,
                    "title": title,
                    "from": from,
                    "note": kind_note,
                })
            };
            for user_id in &annotation.mentions {
                directory
                    .notify(user_id, kb_core::social::kind::MENTION, payload("mention"))
                    .await;
            }
            // 被回复的人:不是自己、还没因为 @ 收到通知、并且能看到这篇文档才通知(评论的作者可能后来被移出协作)
            if let Some(parent_author) = parent_author.filter(|id| id.starts_with("usr_"))
                && Some(&parent_author) != me.as_ref()
                && !annotation.mentions.contains(&parent_author)
                && directory
                    .can_view(&parent_author, &space, &collection, &source)
                    .await
            {
                directory
                    .notify(
                        &parent_author,
                        kb_core::social::kind::COMMENT_REPLY,
                        payload("reply"),
                    )
                    .await;
            }
        }
        Ok(serde_json::to_value(annotation)
            .map_err(|err| KbError::Internal(format!("序列化批注失败: {err}")))?)
    }

    pub(super) async fn resolve_annotation_impl(
        &self,
        args: kb_capability::defs::ResolveAnnotationArgs,
    ) -> Result<Value> {
        // 评论必须真的属于请求里点名的文档:权限闸门是按 collection + source 判断的,
        // 不核对的话,可以拿自己有评论权的文档当幌子去改别的文档上的评论
        let Some(annotation) =
            kb_core::ports::repo::AnnotationRepo::get(self.rt().meta.as_ref(), &args.id).await?
        else {
            return Err(KbError::NotFound(format!("批注 {}", args.id)));
        };
        if annotation.collection != args.collection || annotation.source != args.source {
            return Err(KbError::NotFound(format!("批注 {}", args.id)));
        }
        let updated = self
            .annotations()
            .resolve(&args.id, &self.actor_label(), args.resolved)
            .await?;
        Ok(json!({ "annotation": updated }))
    }

    pub(super) async fn list_annotations_impl(&self, args: ListAnnotationsArgs) -> Result<Value> {
        let annotations = self
            .annotations()
            .list(&args.collection, &args.source, args.limit.unwrap_or(100))
            .await?;
        // 作者和「谁标记的已解决」的资料一起带回去:评论区要显示名字和头像,
        // 而普通评论者没有权限去查别人的资料
        let mut authors = serde_json::Map::new();
        if let Some(directory) = self.comments.get() {
            let mut ids: Vec<String> = annotations
                .iter()
                .flat_map(|a| [a.author.clone(), a.resolved_by.clone()])
                .flatten()
                .filter(|id| id.starts_with("usr_"))
                .collect();
            ids.sort();
            ids.dedup();
            // 游客(经分享链接匿名查看的人)只拿显示名和头像,不给登录用的用户名:
            // 评论区要显示是谁说的,但匿名访客不该顺手拿到可以拿去撞库 / 搜好友的账号名
            let is_guest = self.actor_label().starts_with("guest:");
            for (id, mut profile) in directory.profiles(&ids).await {
                if is_guest && let Some(object) = profile.as_object_mut() {
                    object.remove("username");
                }
                authors.insert(id, profile);
            }
        }
        Ok(json!({ "annotations": annotations, "authors": authors }))
    }

    pub(super) async fn delete_annotation_impl(&self, args: ItemIdArgs) -> Result<Value> {
        self.annotations().delete(&args.id).await?;
        Ok(json!({ "deleted": args.id }))
    }

    pub(super) async fn list_drafts_impl(
        &self,
        _ctx: &CallCtx,
        args: ListDraftsArgs,
    ) -> Result<Value> {
        let state =
            kb_service::evolution::inbox::parse_state(args.state.as_deref().unwrap_or("pending"))?;
        let (page, _) = page_of(args.page, args.page_size);
        let inbox = self.draft_inbox();
        let result = inbox.list(state, page).await?;
        Ok(serde_json::to_value(result)
            .map_err(|err| KbError::Internal(format!("序列化草稿列表失败: {err}")))?)
    }

    pub(super) async fn review_draft_impl(
        &self,
        ctx: &CallCtx,
        args: ReviewDraftArgs,
    ) -> Result<Value> {
        let inbox = self.draft_inbox();
        let actor = actor_of(ctx);
        match args.decision.as_str() {
            "approve" => {
                let edits = kb_service::evolution::ApproveEdits {
                    title: args.title,
                    body_md: args.body_md,
                    tags: args.tags,
                };
                let outcome = inbox.approve(&args.id, &edits, &actor).await?;
                Ok(serde_json::to_value(outcome)
                    .map_err(|err| KbError::Internal(format!("序列化审核结果失败: {err}")))?)
            }
            "reject" => {
                let outcome = inbox.reject(&args.id, args.never_extract).await?;
                Ok(serde_json::to_value(outcome)
                    .map_err(|err| KbError::Internal(format!("序列化审核结果失败: {err}")))?)
            }
            other => Err(KbError::InvalidInput(format!(
                "decision 取值应为 approve / reject,收到 {other}"
            ))),
        }
    }
}

/// `save_insight` 写进条目的作者标签。`InsightService::save` 只认 `user` / `agent` / `mcp:<客户端>`,
/// 而多用户之后调用方的操作者标签有好几种(远程 MCP 令牌是 `agent:mcp:<用户id>`,
/// 内置助手的编码代理是 `agent:<会话>`,API 令牌是 `token:<名字>`),原样往下传会被整条拒绝。
fn insight_author(ctx: &CallCtx) -> String {
    let actor = ctx.actor.as_str();
    if actor == "local" || actor == "user" {
        return match &ctx.client {
            Some(client) => format!("mcp:{client}"),
            None => "user".to_owned(),
        };
    }
    if actor.starts_with("mcp:") || actor == "agent" {
        return actor.to_owned();
    }
    // 远程 MCP:客户端自报了名字就用它,否则统一记成 mcp:remote
    if actor.starts_with("agent:mcp:") {
        return match &ctx.client {
            Some(client) => format!("mcp:{client}"),
            None => "mcp:remote".to_owned(),
        };
    }
    if actor.starts_with("agent:") {
        return "agent".to_owned();
    }
    // API 令牌等脚本调用:算在本人名下
    "user".to_owned()
}

/// 审计里记录的操作者(与 `save_insight` 的口径一致)。
pub(crate) fn actor_of(ctx: &CallCtx) -> String {
    if ctx.actor == "local" {
        match &ctx.client {
            Some(client) => format!("mcp:{client}"),
            None => "user".to_owned(),
        }
    } else {
        ctx.actor.clone()
    }
}

/// `kind` 字符串 → [`kb_core::model::RecordKind`]。
fn parse_record_kind(name: &str) -> Result<kb_core::model::RecordKind> {
    match name {
        "code" => Ok(kb_core::model::RecordKind::Code),
        "doc" => Ok(kb_core::model::RecordKind::Doc),
        "insight" => Ok(kb_core::model::RecordKind::Insight),
        "external" => Ok(kb_core::model::RecordKind::External),
        "summary" => Ok(kb_core::model::RecordKind::Summary),
        other => Err(KbError::InvalidInput(format!(
            "kind 只能是 code / doc / insight / external / summary,收到 {other}"
        ))),
    }
}

/// `kind` 字符串 → [`kb_core::model::InsightKind`]。
fn parse_insight_kind(name: &str) -> Result<kb_core::model::InsightKind> {
    use kb_core::model::InsightKind;
    match name {
        "decision" => Ok(InsightKind::Decision),
        "pitfall" => Ok(InsightKind::Pitfall),
        "howto" => Ok(InsightKind::Howto),
        "convention" => Ok(InsightKind::Convention),
        "note" => Ok(InsightKind::Note),
        other => Err(KbError::InvalidInput(format!(
            "kind 只能是 decision / pitfall / howto / convention / note,收到 {other}"
        ))),
    }
}

impl ServiceBackend {
    /// 批注服务。
    fn annotations(&self) -> kb_service::annotation::AnnotationService {
        kb_service::annotation::AnnotationService::new(
            self.rt().meta.clone(),
            self.rt().store.clone(),
            self.rt().embedder.clone(),
        )
    }

    /// “转 Markdown 副本”服务。
    pub(crate) fn markdown_copies(&self) -> kb_service::annotation::MarkdownCopyService {
        let index = std::sync::Arc::new(kb_service::IndexService::new(
            self.rt().meta.clone(),
            self.rt().store.clone(),
            self.rt().embedder.clone(),
            self.rt().chunker.clone(),
            self.rt().scanner.clone(),
            kb_service::index::IndexOptions::default(),
        ));
        kb_service::annotation::MarkdownCopyService::new(
            self.rt().meta.clone(),
            index,
            self.rt().paths.clone(),
        )
    }
}

#[cfg(test)]
mod insight_author_tests {
    use super::*;
    use kb_capability::Surface;

    fn ctx(actor: &str, client: Option<&str>) -> CallCtx {
        let mut ctx = CallCtx::new(actor.to_owned(), Surface::Mcp);
        ctx.client = client.map(str::to_owned);
        ctx
    }

    #[test]
    fn every_kind_of_caller_gets_a_label_save_insight_accepts() {
        let cases = [
            ("local", None, "user"),
            ("local", Some("claude-code"), "mcp:claude-code"),
            ("user", None, "user"),
            ("user", Some("cursor"), "mcp:cursor"),
            ("agent", None, "agent"),
            ("mcp:codex", None, "mcp:codex"),
            ("agent:mcp:usr_123", None, "mcp:remote"),
            ("agent:mcp:usr_123", Some("claude-code"), "mcp:claude-code"),
            ("agent:sess-9", None, "agent"),
            ("token:scripts", None, "user"),
        ];
        for (actor, client, expected) in cases {
            let label = insight_author(&ctx(actor, client));
            assert_eq!(label, expected, "actor={actor} client={client:?}");
            assert!(
                label == "user" || label == "agent" || label.starts_with("mcp:"),
                "{label} 会被 save_insight 拒绝"
            );
        }
    }
}
