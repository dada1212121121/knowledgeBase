//! 双向链接:文件与笔记之间的连线、断链检查。

use crate::capability_backend::*;

/// 笔记引用目标的 id 提取:显式 `kind=note` 或带 `note_id` 才算笔记;
/// 兼容只传 `path` 的旧客户端,但文件目标绝不能误入笔记分支。
fn note_target_id(target: &LinkTarget) -> Option<String> {
    let is_note = target.kind.as_deref() == Some("note") || target.note_id.is_some();
    if !is_note {
        return None;
    }
    let id = target
        .note_id
        .as_deref()
        .filter(|id| !id.trim().is_empty())
        .or_else(|| (!target.path.trim().is_empty()).then_some(target.path.as_str()))
        .unwrap_or_default()
        .trim()
        .to_owned();
    Some(id)
}

/// 笔记 id 只允许 uuid / 旧测试 id 这类安全字符,长度也设上限:
/// 避免把任意长字符串塞进库查询,也避免日志和界面被控制字符污染。
fn valid_note_id(id: &str) -> bool {
    !id.is_empty()
        && id.chars().count() <= 128
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

#[allow(clippy::needless_question_mark)]
impl ServiceBackend {
    pub(super) async fn doc_links_impl(&self, args: DocLinksArgs) -> Result<Value> {
        let direction = args.direction.as_deref().unwrap_or("both");
        if !matches!(direction, "from" | "to" | "both") {
            return Err(KbError::InvalidInput(
                "direction 只能是 from / to / both".to_owned(),
            ));
        }
        let limit = args.limit.unwrap_or(100).clamp(1, 500);
        // 目录查询:只看入链,用来在删除 / 移动文件夹前提示“有多少篇文档会断”
        if let Some(prefix) = args.path_prefix {
            let collection = args
                .collection
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| KbError::InvalidInput("collection 不能为空".to_owned()))?;
            let prefix = prefix.trim_matches('/').to_owned();
            if prefix.is_empty()
                || prefix
                    .split('/')
                    .any(|part| part.is_empty() || part == "." || part == "..")
            {
                return Err(KbError::InvalidInput("path_prefix 不合法".to_owned()));
            }
            let rows =
                DocLinkRepo::links_under(self.rt().meta.as_ref(), &collection, &prefix, limit)
                    .await?;
            let mut seen = std::collections::HashSet::new();
            let mut inbound = Vec::new();
            for row in rows {
                if seen.insert((
                    row.source_kind.clone(),
                    row.source_collection.clone(),
                    row.source_id.clone(),
                )) {
                    inbound.push(row);
                }
            }
            return Ok(json!({
                "source": { "kind": "folder", "collection": collection, "id": prefix, "title": prefix },
                "outbound": [],
                "inbound": inbound.iter().map(doc_link_json).collect::<Vec<_>>(),
                "total": { "outbound": 0, "inbound": inbound.len() },
            }));
        }
        let (kind, collection, id, title) = if let Some(note_id) = args.note_id {
            // 笔记 id 只允许安全字符:不能把任意字符串带进 SQL 参数以外的地方
            if !valid_note_id(&note_id) {
                return Err(KbError::InvalidInput("笔记 id 不合法".to_owned()));
            }
            let insight = InsightRepo::get(self.rt().meta.as_ref(), &note_id)
                .await?
                .ok_or_else(|| KbError::NotFound(format!("笔记 {note_id}")))?;
            ("note", insight.collection, insight.id, insight.title)
        } else {
            let collection = args
                .collection
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| KbError::InvalidInput("collection 不能为空".to_owned()))?;
            let path = args
                .path
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| KbError::InvalidInput("path 不能为空".to_owned()))?;
            // 借 file_raw 统一做存在性 / 范围校验;不能只查链接表,否则已删除的文件也能反查
            let raw = self
                .file_raw(FileRawArgs {
                    collection: collection.clone(),
                    path: path.clone(),
                })
                .await?;
            let title = raw
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_else(|| path.rsplit('/').next().unwrap_or(&path))
                .to_owned();
            ("file", collection, path, title)
        };
        let outbound = if direction == "to" {
            Vec::new()
        } else {
            DocLinkRepo::links_from(self.rt().meta.as_ref(), kind, &collection, &id).await?
        };
        let inbound = if direction == "from" {
            Vec::new()
        } else {
            DocLinkRepo::links_to(self.rt().meta.as_ref(), kind, &collection, &id, limit).await?
        };
        Ok(json!({
            "source": { "kind": kind, "collection": collection, "id": id, "title": title },
            "outbound": outbound.iter().map(doc_link_json).collect::<Vec<_>>(),
            "inbound": inbound.iter().map(doc_link_json).collect::<Vec<_>>(),
            "total": { "outbound": outbound.len(), "inbound": inbound.len() },
        }))
    }

    pub(super) async fn check_links_impl(&self, args: CheckLinksArgs) -> Result<Value> {
        // 链接体检不是目录扫描接口:一次最多 200 条,路径长度也设上限。
        if args.targets.len() > 200 {
            return Err(KbError::InvalidInput("一次最多检查 200 个链接".to_owned()));
        }
        let mut items = Vec::with_capacity(args.targets.len());
        for target in args.targets {
            // 笔记目标没有文件路径,单独查 insights;错误文案同样不能泄露目标是否存在。
            if let Some(note_id) = note_target_id(&target) {
                let valid = valid_note_id(&note_id);
                let (state, reason, collection, name) = if !valid {
                    (
                        "invalid",
                        "笔记 id 不合法".to_owned(),
                        String::new(),
                        Value::Null,
                    )
                } else {
                    match InsightRepo::get(self.rt().meta.as_ref(), &note_id).await {
                        Ok(Some(insight)) => (
                            "ok",
                            String::new(),
                            insight.collection,
                            Value::String(insight.title),
                        ),
                        Ok(None) => (
                            "missing",
                            "笔记不在知识库里".to_owned(),
                            String::new(),
                            Value::Null,
                        ),
                        Err(_) => (
                            "unknown",
                            "暂时无法检查".to_owned(),
                            String::new(),
                            Value::Null,
                        ),
                    }
                };
                items.push(json!({
                    "kind": "note",
                    "note_id": note_id,
                    "collection": collection,
                    "path": "",
                    "state": state,
                    "reason": reason,
                    "size": Value::Null,
                    "name": name,
                }));
                continue;
            }
            let collection = target.collection;
            let path = target.path;
            let invalid = collection.trim().is_empty()
                || path.trim().is_empty()
                || path.chars().count() > 4096
                || path.chars().any(char::is_control);
            let (state, reason, size, name) = if invalid {
                ("invalid", "路径不合法".to_owned(), Value::Null, Value::Null)
            } else {
                match self
                    .file_raw(FileRawArgs {
                        collection: collection.clone(),
                        path: path.clone(),
                    })
                    .await
                {
                    Ok(value) => (
                        "ok",
                        String::new(),
                        value.get("size").cloned().unwrap_or(Value::Null),
                        value.get("name").cloned().unwrap_or(Value::Null),
                    ),
                    // 错误文案只给「为什么打不开」,不把服务端的绝对路径带出去;
                    // 分享链接下 `file_raw` 已经按 root 做过范围校验,这里不能泄露目标是否存在。
                    Err(KbError::Forbidden(_)) => (
                        "outside",
                        "没有访问权限".to_owned(),
                        Value::Null,
                        Value::Null,
                    ),
                    Err(KbError::NotFound(_)) => (
                        "missing",
                        "文件不在知识库里".to_owned(),
                        Value::Null,
                        Value::Null,
                    ),
                    Err(KbError::InvalidInput(_)) => {
                        ("invalid", "路径不合法".to_owned(), Value::Null, Value::Null)
                    }
                    Err(_) => (
                        "unknown",
                        "暂时无法检查".to_owned(),
                        Value::Null,
                        Value::Null,
                    ),
                }
            };
            items.push(json!({
                "kind": "file",
                "collection": collection,
                "path": path,
                "state": state,
                "reason": reason,
                "size": size,
                "name": name,
            }));
        }
        Ok(json!({ "items": items }))
    }
}

/// 解析器输出的一条引用;`save_insight` / `doc_edit` 回给调用方自检用。
pub(crate) fn parsed_link_json(link: &kb_service::doc_links::ParsedLink) -> Value {
    json!({
        "href": link.href,
        "line": link.line,
        "label": link.label,
        "kind": link.target_kind,
        "collection": link.target_collection,
        "target": link.target_id,
        "reason": link.reason,
    })
}

/// 链接图谱的一行:出链和入链共用同一组字段,前端不用分两套解析。
fn doc_link_json(link: &kb_core::model::DocLink) -> Value {
    json!({
        "source_kind": link.source_kind,
        "source_collection": link.source_collection,
        "source_id": link.source_id,
        "source_title": link.source_title,
        "href": link.href,
        "line": link.line,
        "label": link.label,
        "target_kind": link.target_kind,
        "target_collection": link.target_collection,
        "target_id": link.target_id,
        "reason": link.reason,
        "indexed_at": link.indexed_at,
    })
}

#[cfg(test)]
mod link_target_tests {
    //! `check_links` 的笔记目标判定:不能把文件目标误当笔记,也不能让危险 id 进库查询。
    use super::{note_target_id, valid_note_id};
    use kb_capability::defs::LinkTarget;

    fn target(
        kind: Option<&str>,
        collection: &str,
        path: &str,
        note_id: Option<&str>,
    ) -> LinkTarget {
        LinkTarget {
            kind: kind.map(str::to_owned),
            collection: collection.to_owned(),
            path: path.to_owned(),
            note_id: note_id.map(str::to_owned),
        }
    }

    #[test]
    fn note_targets_are_recognised_by_kind_or_note_id() {
        let explicit = target(
            Some("note"),
            "",
            "",
            Some("01a19f63-f0ea-72fe-aa19-9998f6e2e5ad"),
        );
        assert_eq!(
            note_target_id(&explicit).as_deref(),
            Some("01a19f63-f0ea-72fe-aa19-9998f6e2e5ad")
        );
        // 旧客户端只传 path / 只传 note_id 也要认
        let path_only = target(Some("note"), "", " ins_8b10 ", None);
        assert_eq!(note_target_id(&path_only).as_deref(), Some("ins_8b10"));
        let id_only = target(None, "", "", Some("ins_8b10"));
        assert_eq!(note_target_id(&id_only).as_deref(), Some("ins_8b10"));
        // 普通文件目标绝不能走笔记分支
        let file = target(Some("file"), "proj", "docs/a.md", None);
        assert!(note_target_id(&file).is_none());
        assert!(note_target_id(&target(None, "proj", "docs/a.md", None)).is_none());
    }

    #[test]
    fn note_ids_stay_within_safe_characters_and_length() {
        assert!(valid_note_id("01a19f63-f0ea-72fe-aa19-9998f6e2e5ad"));
        assert!(valid_note_id("ins_8b10"));
        for bad in ["", " ", "a/b", "a..b", "笔记", "id\n", &"a".repeat(129)] {
            assert!(!valid_note_id(bad), "{bad:?} 不该通过");
        }
    }
}
