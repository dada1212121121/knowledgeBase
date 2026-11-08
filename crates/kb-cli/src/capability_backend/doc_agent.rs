//! AI 读 / 改在线文档:`doc_read`、`doc_edit`、`doc_proposals`、`doc_proposal_decide`。
//!
//! 所有能在线编辑的格式一个入口:笔记、Markdown 文件、代码与文本、CSV / TSV、Word / Excel / PowerPoint。
//! 修改的单位是「把这段原文换成那段」,原文必须恰好出现一次,一批改动整批生效或整批不生效。
//!
//! - 文档正在多人编辑(房间开着):修改作为服务端的一笔更新并进房间,实时出现在每个人的编辑器里,
//!   之后照常落地;不踢人,不覆盖别人刚写的内容。
//! - 没有人在编辑:笔记 / 文本直接改存储里的正文(生成一个版本);Office 文件临时开一个房间改完落地。
//! - 默认 AI 只能提建议(`edit_proposals` 表),人在页面上接受才生效;`[office] agent_direct_edit = true`
//!   时 AI 直接改。人自己在页面上调 `doc_edit` 总是直接改。

use kb_core::ports::repo::{InsightRepo, VersionRepo};
use kb_core::share::ResourceKey;
use kb_core::{KbError, Result};
use serde_json::{Value, json};

use super::{ServiceBackend, is_ai_actor};
use kb_capability::defs::{
    DocEditArgs, DocProposalDecideArgs, DocProposalsArgs, DocReadArgs, DocTextEdit,
};
use kb_capability::invoke::CallCtx;

/// 一批最多几处。
const MAX_EDITS: usize = 32;
/// 一批替换的文字总量上限(字节)。
const MAX_EDIT_BYTES: usize = 1 << 20;
/// 一个文档上最多几条等待处理的建议。
const MAX_PENDING: u32 = 50;
/// `doc_read` 默认 / 最多返回几行。
const DEFAULT_LINES: usize = 400;
const MAX_LINES: usize = 2000;

/// 修改的目标。
#[derive(Clone, Debug)]
enum DocTarget {
    File { collection: String, path: String },
    Note { collection: String, id: String },
}

impl DocTarget {
    /// 存进建议表的写法。
    fn stored(&self) -> (String, String) {
        match self {
            DocTarget::File { collection, path } => (collection.clone(), format!("file:{path}")),
            DocTarget::Note { collection, id } => (collection.clone(), format!("note:{id}")),
        }
    }

    /// Office 文件的格式;不是 Office 返回 `None`。
    fn office_format(&self) -> Option<&'static str> {
        let DocTarget::File { path, .. } = self else {
            return None;
        };
        let extension = path.rsplit_once('.')?.1.to_ascii_lowercase();
        ["docx", "xlsx", "pptx"]
            .into_iter()
            .find(|format| *format == extension)
    }

    /// 给 AI 看的类型。
    fn kind(&self) -> &'static str {
        match self {
            DocTarget::Note { .. } => "note",
            DocTarget::File { path, .. } => {
                if let Some(format) = self.office_format() {
                    return format;
                }
                match kb_collab::DocKind::for_file(path) {
                    kb_collab::DocKind::Rich => "markdown",
                    kb_collab::DocKind::Text => "text",
                }
            }
        }
    }

    fn is_rich(&self) -> bool {
        matches!(self.kind(), "note" | "markdown")
    }
}

/// 调用者是不是 AI(MCP、ACP 伴生、带 `X-KB-Client` 的 admin key 调用)。
fn caller_is_ai(ctx: &CallCtx) -> bool {
    is_ai_actor(&ctx.actor)
        || (matches!(ctx.actor.as_str(), "user" | "local") && ctx.client.is_some())
}

/// 写进建议 / 版本 / 房间参与者的「谁」:AI 写 `mcp:<客户端>`,人写自己的账号。
fn author_of(ctx: &CallCtx, fallback: String) -> String {
    if ctx.actor.starts_with("mcp:") || ctx.actor.starts_with("agent") {
        return ctx.actor.clone();
    }
    match ctx.client.as_deref() {
        Some(client) => format!("mcp:{client}"),
        None => fallback,
    }
}

fn check_edits(edits: &[DocTextEdit]) -> Result<Vec<(String, String)>> {
    if edits.is_empty() {
        return Err(KbError::InvalidInput("至少要有一处修改".to_owned()));
    }
    if edits.len() > MAX_EDITS {
        return Err(KbError::InvalidInput(format!(
            "一次最多改 {MAX_EDITS} 处,请分批"
        )));
    }
    let total: usize = edits.iter().map(|e| e.old.len() + e.new.len()).sum();
    if total > MAX_EDIT_BYTES {
        return Err(KbError::InvalidInput(
            "这一批修改太长了(超过 1 MB),请分批".to_owned(),
        ));
    }
    if edits.iter().any(|e| e.old.is_empty()) {
        return Err(KbError::InvalidInput(
            "要替换的原文不能为空(想插入文字就把前后的原文一起写上)".to_owned(),
        ));
    }
    Ok(edits
        .iter()
        .map(|e| (e.old.clone(), e.new.clone()))
        .collect())
}

/// 给人看的失败原因:去掉错误类型的英文前缀(`invalid input: …`)。
fn reason_of(err: &KbError) -> String {
    match err {
        KbError::NotFound(text)
        | KbError::InvalidInput(text)
        | KbError::Exists(text)
        | KbError::Forbidden(text)
        | KbError::Unavailable(text) => text.clone(),
        KbError::Conflict { .. } => "文档在这期间被别人改过了".to_owned(),
        other => other.to_string(),
    }
}

/// 当前调用者有没有这个功能点(不在能力调用里按本机身份放行)。
fn require_feature(feature: &str, message: &str) -> Result<()> {
    match kb_capability::current_principal() {
        None => Ok(()),
        Some(principal) if principal.features.allows(feature) => Ok(()),
        Some(_) => Err(KbError::Forbidden(message.to_owned())),
    }
}

impl ServiceBackend {
    /// 参数 → 目标。笔记要查出它在哪个集合。
    async fn doc_target(
        &self,
        collection: Option<String>,
        path: Option<String>,
        note_id: Option<String>,
    ) -> Result<DocTarget> {
        match (note_id, path) {
            (Some(id), None) => {
                let insight = InsightRepo::get(self.rt().meta.as_ref(), &id)
                    .await?
                    .ok_or_else(|| KbError::NotFound(format!("笔记 {id}")))?;
                Ok(DocTarget::Note {
                    collection: insight.collection,
                    id,
                })
            }
            (None, Some(path)) => {
                let collection = collection.ok_or_else(|| {
                    KbError::InvalidInput("改文件要同时给 collection 和 path".to_owned())
                })?;
                Ok(DocTarget::File { collection, path })
            }
            _ => Err(KbError::InvalidInput(
                "要给 note_id(笔记)或 collection + path(文件),二选一".to_owned(),
            )),
        }
    }

    fn doc_key(&self, target: &DocTarget) -> Result<ResourceKey> {
        let space = self.call_space_id();
        match target {
            DocTarget::File { collection, path } => ResourceKey::file(&space, collection, path),
            DocTarget::Note { collection, id } => ResourceKey::insight(&space, collection, id),
        }
    }

    fn office_or_unavailable(&self) -> Result<std::sync::Arc<crate::office_collab::OfficeCollab>> {
        self.office.get().cloned().ok_or_else(|| {
            KbError::Unavailable(
                "办公文档协同没有启用,AI 不能读改 Word / Excel / PowerPoint".to_owned(),
            )
        })
    }

    /// 文档现在的内容 + 是不是正在多人编辑。
    async fn doc_content(&self, target: &DocTarget) -> Result<(String, bool)> {
        let key = self.doc_key(target)?;
        if target.office_format().is_some() {
            let office = self.office_or_unavailable()?;
            let live = office.active(&key);
            return Ok((office.agent_read(&key).await?, live));
        }
        if let Some(hub) = self.collab.get()
            && let Some(text) = hub.read_live(&key.to_string()).await
        {
            return Ok((text, true));
        }
        let text = match target {
            DocTarget::File { collection, path } => {
                self.file_edits().read_text(collection, path).await?
            }
            DocTarget::Note { id, .. } => {
                InsightRepo::get(self.rt().meta.as_ref(), id)
                    .await?
                    .ok_or_else(|| KbError::NotFound(format!("笔记 {id}")))?
                    .body_md
            }
        };
        Ok((text, false))
    }

    /// 应用一批修改(直接改和接受建议共用)。`dry` 只核对每处原文能不能定位。
    async fn apply_doc_edits(
        &self,
        target: &DocTarget,
        edits: &[(String, String)],
        author: &str,
        dry: bool,
    ) -> Result<Value> {
        let key = self.doc_key(target)?;
        if target.office_format().is_some() {
            let office = self.office_or_unavailable()?;
            let changed = office.agent_edit(&key, edits, author, dry).await?;
            return Ok(json!({ "changed": changed, "live": true }));
        }
        let room_key = key.to_string();
        if let Some(hub) = self.collab.get() {
            if dry {
                if let Some(text) = hub.read_live(&room_key).await {
                    if target.is_rich() && edits.iter().any(|(old, _)| old.contains('\n')) {
                        return Err(KbError::InvalidInput(
                            "文档正在多人编辑,原文不能跨段落(每次只改一段里的文字)".to_owned(),
                        ));
                    }
                    kb_collab::core::replace_unique(&text, edits).map_err(KbError::InvalidInput)?;
                    return Ok(json!({ "changed": edits.len(), "live": true }));
                }
            } else {
                let who = kb_collab::Participant {
                    id: author.to_owned(),
                    name: author.to_owned(),
                };
                if let Some(result) = hub.apply_edits(&room_key, edits, who).await {
                    return Ok(json!({ "changed": result?, "live": true }));
                }
            }
        }
        // 没有人在编辑:改存储里的正文
        let (before, _) = self.doc_content(target).await?;
        let after =
            kb_collab::core::replace_unique(&before, edits).map_err(KbError::InvalidInput)?;
        if dry {
            return Ok(json!({ "changed": edits.len(), "live": false }));
        }
        match target {
            DocTarget::File { collection, path } => {
                let item_id = kb_service::edit::FileEditService::item_id(collection, path);
                let latest = VersionRepo::latest_version(self.rt().meta.as_ref(), &item_id).await?;
                let saved = self
                    .file_edits()
                    .save(kb_service::edit::SaveFileRequest {
                        collection: collection.clone(),
                        path: path.clone(),
                        content: after,
                        // 读和写之间别人保存过:409,AI 重新读一遍再改
                        expected_version: Some(latest),
                        author: author.to_owned(),
                        tags: Vec::new(),
                    })
                    .await?;
                self.tell_collab_of_external_write(Some(key)).await;
                Ok(json!({ "changed": edits.len(), "live": false, "version": saved.version }))
            }
            DocTarget::Note { collection, id } => {
                let insight = InsightRepo::get(self.rt().meta.as_ref(), id)
                    .await?
                    .ok_or_else(|| KbError::NotFound(format!("笔记 {id}")))?;
                if insight.body_md != before {
                    return Err(KbError::Exists(
                        "笔记在读和改之间被别人改过了,请重新读一遍再改".to_owned(),
                    ));
                }
                let result = self
                    .items()
                    .edit(
                        kb_service::EditRequest {
                            id: id.clone(),
                            version: Some(insight.version),
                            title: None,
                            body: Some(after),
                            tags: None,
                            kind: None,
                            // AI 改文档也留版本历史:谁改的写在 author 里
                            author: Some(self.actor_label()),
                        },
                        None,
                    )
                    .await?;
                self.publish_item_changed("edited", id, collection);
                self.tell_collab_of_external_write(Some(key)).await;
                Ok(json!({ "changed": edits.len(), "live": false, "version": result.version }))
            }
        }
    }

    /// 当前文档的引用清单。只解析富文本(Markdown / 笔记),代码 / 表格里的方括号不是链接。
    async fn links_of(&self, target: &DocTarget) -> Result<Value> {
        if !target.is_rich() {
            return Ok(json!([]));
        }
        let (text, _) = self.doc_content(target).await?;
        let (collection, path) = match target {
            DocTarget::File { collection, path } => (collection.clone(), Some(path.as_str())),
            DocTarget::Note { collection, .. } => (collection.clone(), None),
        };
        let links = kb_service::doc_links::parse_doc_links(&text, &collection, path);
        Ok(json!(
            links
                .iter()
                .map(super::parsed_link_json)
                .collect::<Vec<_>>()
        ))
    }

    fn require_edit_feature(target: &DocTarget) -> Result<()> {
        if matches!(target, DocTarget::Note { .. }) {
            require_feature("docs.notes", "改笔记需要「笔记」功能权限")?;
        }
        Ok(())
    }

    fn publish_proposal(&self, collection: &str, target: &str, id: &str, status: &str) {
        if let Some(hub) = &self.hub {
            hub.publish(
                "proposal.changed",
                json!({ "collection": collection, "target": target, "id": id, "status": status }),
            );
        }
    }

    pub(super) async fn doc_read_impl(&self, args: DocReadArgs) -> Result<Value> {
        let target = self
            .doc_target(args.collection, args.path, args.note_id)
            .await?;
        let (text, live) = self.doc_content(&target).await?;
        let lines: Vec<&str> = text.split('\n').collect();
        let offset = (args.offset.unwrap_or(0) as usize).min(lines.len());
        let limit = (args.limit.map_or(DEFAULT_LINES, |n| n as usize)).clamp(1, MAX_LINES);
        let end = (offset + limit).min(lines.len());
        let hint = match (target.kind(), live) {
            ("note" | "markdown", true) => {
                "文档正在多人编辑:读到的是每段的纯文字(一段一行,不带 Markdown 标记)。doc_edit 的原文照这里写,不能跨段;修改会实时出现在大家的编辑器里"
            }
            ("note" | "markdown", false) => "Markdown 原文;doc_edit 的原文照这里写",
            ("xlsx", _) => {
                "每格写成 `A1=值`(公式写成 `A1==公式`)。改格子时原文写格子里存的值(或其中一段),不能改公式"
            }
            ("docx", _) => "每段一行;原文不能跨段",
            ("pptx", _) => "按幻灯片分组,每段一行;原文不能跨段",
            (_, true) => "文档正在多人编辑,读到的是大家正在改的内容;修改会实时出现在大家的编辑器里",
            _ => "原文;doc_edit 的原文照这里写(带上足够的上下文让它唯一)",
        };
        let mut out = json!({
            "kind": target.kind(),
            "live": live,
            "offset": offset,
            "total_lines": lines.len(),
            "next_offset": (end < lines.len()).then_some(end),
            "text": lines[offset..end].join("\n"),
            "hint": hint,
        });
        if let DocTarget::Note { id, .. } = &target
            && let Some(insight) = InsightRepo::get(self.rt().meta.as_ref(), id).await?
        {
            out["title"] = json!(insight.title);
        }
        Ok(out)
    }

    pub(super) async fn doc_edit_impl(&self, ctx: &CallCtx, args: DocEditArgs) -> Result<Value> {
        let target = self
            .doc_target(args.collection, args.path, args.note_id)
            .await?;
        Self::require_edit_feature(&target)?;
        let edits = check_edits(&args.edits)?;
        let author = author_of(ctx, self.actor_label());
        let direct = !caller_is_ai(ctx) || self.rt().config().office.agent_direct_edit;
        if direct {
            let mut result = self
                .apply_doc_edits(&target, &edits, &author, false)
                .await?;
            result["applied"] = json!(true);
            // 改完立刻把最新引用回给调用方:AI 不用再读一遍正文才知道自己刚写了哪些链接
            result["links"] = self.links_of(&target).await?;
            return Ok(result);
        }
        let (collection, stored) = target.stored();
        // 一个文档上等着处理的建议有上限:AI 出错反复提交时不会把表和页面撑爆
        let waiting = self
            .rt()
            .meta
            .proposal_list(&collection, &stored, Some("pending"), MAX_PENDING)
            .await?;
        if waiting.len() >= MAX_PENDING as usize {
            return Err(KbError::Exists(format!(
                "这个文档上已经有 {MAX_PENDING} 条修改建议在等人处理,先等处理完再提"
            )));
        }
        // 只提建议:先核对每处原文现在能定位,免得人去接受一条注定失败的建议
        self.apply_doc_edits(&target, &edits, &author, true).await?;
        let id = format!("prop_{}", uuid::Uuid::now_v7().simple());
        self.rt()
            .meta
            .proposal_create(kb_meta::EditProposal {
                id: id.clone(),
                collection: collection.clone(),
                target: stored.clone(),
                author,
                note: args.reason.unwrap_or_default().chars().take(500).collect(),
                edits: json!(
                    args.edits
                        .iter()
                        .map(|e| json!({ "old": e.old, "new": e.new }))
                        .collect::<Vec<_>>()
                ),
                status: "pending".to_owned(),
                result: None,
                created_at: crate::daemon::now_millis(),
                decided_at: None,
                decided_by: None,
            })
            .await?;
        self.publish_proposal(&collection, &stored, &id, "pending");
        Ok(json!({
            "applied": false,
            "proposal_id": id,
            "message": "已生成修改建议,等人在页面上接受后才会生效(系统参数「AI 直接修改文档」打开后 AI 可以直接改)",
        }))
    }

    pub(super) async fn doc_proposals_impl(&self, args: DocProposalsArgs) -> Result<Value> {
        let target = self
            .doc_target(args.collection, args.path, args.note_id)
            .await?;
        let (collection, stored) = target.stored();
        let proposals = self
            .rt()
            .meta
            .proposal_list(&collection, &stored, args.status.as_deref(), 50)
            .await?;
        Ok(json!({ "proposals": proposals }))
    }

    pub(super) async fn doc_proposal_decide_impl(
        &self,
        ctx: &CallCtx,
        args: DocProposalDecideArgs,
    ) -> Result<Value> {
        // 能力只在 Web 面上,但带着浏览器 cookie / admin key 走 HTTP 的 AI 也在 Web 面:按调用者再挡一次
        if caller_is_ai(ctx) {
            return Err(KbError::Forbidden(
                "AI 不能接受或拒绝修改建议,要由人在页面上决定".to_owned(),
            ));
        }
        let meta = self.rt().meta.clone();
        let proposal = meta
            .proposal_get(&args.id)
            .await?
            .ok_or_else(|| KbError::NotFound("没有找到这条建议".to_owned()))?;
        let target = match proposal.target.split_once(':') {
            Some(("file", path)) => DocTarget::File {
                collection: proposal.collection.clone(),
                path: path.to_owned(),
            },
            Some(("note", id)) => DocTarget::Note {
                collection: proposal.collection.clone(),
                id: id.to_owned(),
            },
            _ => return Err(KbError::Internal("建议的目标格式不对".to_owned())),
        };
        if args.accept {
            Self::require_edit_feature(&target)?;
        }
        let by = self.actor_label();
        let status = if args.accept { "accepted" } else { "rejected" };
        // 先认领再应用:两个人同时点「接受」只会应用一次
        if !meta
            .proposal_decide(&args.id, status, &by, None, crate::daemon::now_millis())
            .await?
        {
            return Err(KbError::Exists("这条建议已经处理过了".to_owned()));
        }
        let mut result = json!({ "id": args.id, "status": status });
        if args.accept {
            let edits: Vec<(String, String)> = proposal
                .edits
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .map(|item| {
                            (
                                item["old"].as_str().unwrap_or_default().to_owned(),
                                item["new"].as_str().unwrap_or_default().to_owned(),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default();
            match self
                .apply_doc_edits(&target, &edits, &proposal.author, false)
                .await
            {
                Ok(applied) => {
                    result["changed"] = applied["changed"].clone();
                    result["live"] = applied["live"].clone();
                }
                Err(err) => {
                    let reason = reason_of(&err);
                    meta.proposal_fail(&args.id, &reason).await?;
                    result["status"] = json!("failed");
                    result["error"] = json!(reason);
                }
            }
        }
        self.publish_proposal(
            &proposal.collection,
            &proposal.target,
            &args.id,
            result["status"].as_str().unwrap_or(status),
        );
        Ok(result)
    }
}
