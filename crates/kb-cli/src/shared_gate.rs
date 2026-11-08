//! 分享闸门:别人的知识库里,调用者能调哪些能力、够不够权限(多用户设计说明)。
//!
//! 调用者在请求头 `X-KB-Space` 里点名别人的知识库时,`Invoker` 把这次调用交给这里:
//! 1. 能力必须在 [`SPECS`] 白名单里——白名单之外的(改配置、管理来源、AI、导入……)在别人的知识库里一律不可用;
//! 2. 从参数里找出它指向的资源(一条笔记、一个文件、一个文件夹),算调用者对它的**有效角色**;
//! 3. 角色够做这个动作才放行,并把这次调用改路由到所有者的知识库;列表类结果再按行过滤。
//!
//! 没有任何权限一律 `NotFound`(不暴露对方有没有这个东西),有权限但不够才是 `Forbidden`。
//! 所有者本人用自己的知识库,不经过这里。

use std::sync::Arc;

use async_trait::async_trait;
use kb_capability::Principal;
use kb_capability::invoke::{LinkGrant, ResolvedSpace, ResponseFilter, ShareGate, SharedAccess};
use kb_core::model::Millis;
use kb_core::ports::repo::{AuditRepo, CollectionRepo, InsightRepo};
use kb_core::share::{Action, ResourceKey};
use kb_core::{KbError, Result};
use kb_meta::SystemStore;
use serde_json::Value;

use crate::runtime::Embedded;
use crate::spaces::SpaceRegistry;

/// 参数怎么指向资源。
#[derive(Clone, Copy, Debug)]
enum Extract {
    /// `id`:一条笔记或一个内容块。到所有者的库里查它属于哪个集合、哪个文件。
    ItemId,
    /// `collection` + `path`:一个文件。
    File,
    /// `targets`:一批文件引用(链接体检;每一目标都要单独过范围 / 角色校验)。
    Links,
    /// `collection` + 可选 `path_prefix`:一个范围(列表用)。
    Scope,
    /// `collection`:在集合里新建。
    Collection,
    /// `collection` + `source`:批注挂在哪个文档上(`insight:<id>` 是笔记,其余是文件路径)。
    Source,
    /// AI 读 / 改文档:`note_id` 是笔记,否则 `collection` + `path` 是文件。
    Doc,
    /// `id`:一条修改建议,按它指向的文档判断。
    Proposal,
}

/// 一条白名单。
struct Spec {
    name: &'static str,
    /// 需要的动作。
    action: Action,
    /// 资源怎么找。
    extract: Extract,
    /// 通过**分享链接**(含游客)是否也开放。读和评论、编辑开放;删除、新建、版本历史不开放。
    via_link: bool,
}

const fn spec(name: &'static str, action: Action, extract: Extract, via_link: bool) -> Spec {
    Spec {
        name,
        action,
        extract,
        via_link,
    }
}

/// 分享场景下允许的能力。不在表里的能力在别人的知识库里不可用。
/// 新增一项要同时想清楚:它最低需要哪个角色?链接访问者(尤其是游客)该不该有?
const SPECS: &[Spec] = &[
    spec("get_item", Action::View, Extract::ItemId, true),
    spec("list_items", Action::View, Extract::Scope, true),
    // 文件选择器只给登录的协作者用;分享链接上不需要,也避免把整个集合的文件名暴露给游客
    spec("list_files", Action::View, Extract::Scope, false),
    spec("file_preview", Action::View, Extract::File, true),
    spec("file_raw", Action::Download, Extract::File, true),
    spec("check_links", Action::View, Extract::Links, true),
    spec("list_annotations", Action::View, Extract::Source, true),
    spec("add_annotation", Action::Comment, Extract::Source, true),
    // 标记已解决只给登录的协作者:游客(链接)能评论,但不能替别人把评论关掉
    spec(
        "resolve_annotation",
        Action::Comment,
        Extract::Source,
        false,
    ),
    spec("item_history", Action::History, Extract::ItemId, false),
    spec("file_versions", Action::History, Extract::File, false),
    // 文件菜单是只读查询(能不能删/移由服务端按真实权限算);删除要 Manager,链接访问者不开放
    spec("file_actions", Action::View, Extract::File, true),
    spec("delete_file", Action::Delete, Extract::File, false),
    spec("delete_folder", Action::Delete, Extract::File, false),
    spec("edit_item", Action::Edit, Extract::ItemId, true),
    spec("save_file", Action::Edit, Extract::File, true),
    spec("create_item", Action::Create, Extract::Collection, false),
    spec("delete_item", Action::Delete, Extract::ItemId, false),
    // AI 读 / 改别人分享给我的文档:和我自己在页面上看 / 改需要的角色一样;链接访问者没有 MCP
    spec("doc_read", Action::View, Extract::Doc, false),
    // 引用图谱会带出集合里其它文档的标题 / 路径;分享链接上不开放,避免越权泄露
    spec("doc_links", Action::View, Extract::Doc, false),
    spec("doc_edit", Action::Edit, Extract::Doc, false),
    spec("doc_proposals", Action::View, Extract::Doc, false),
    spec(
        "doc_proposal_decide",
        Action::Edit,
        Extract::Proposal,
        false,
    ),
];

/// 分享闸门。
pub struct SharedGate {
    system: Arc<SystemStore>,
    spaces: Arc<SpaceRegistry>,
}

impl SharedGate {
    /// 构造。
    pub fn new(system: Arc<SystemStore>, spaces: Arc<SpaceRegistry>) -> Arc<Self> {
        Arc::new(Self { system, spaces })
    }

    /// 这个调用者对 `key` 有没有 `action` 权限。用户看自己的授权,链接只看覆盖范围 + 链接角色。
    async fn allow(
        &self,
        user: &str,
        key: &ResourceKey,
        action: Action,
        link: Option<&LinkGrant>,
        now: Millis,
    ) -> Result<()> {
        match link {
            None => {
                self.system.require_role(user, key, action, now).await?;
            }
            Some(grant) => {
                // 链接只覆盖它指向的资源和它们底下的东西,范围之外的一律当作不存在
                if !grant.roots.iter().any(|root| key.is_within(root)) {
                    return Err(KbError::NotFound("没有找到这个内容".to_owned()));
                }
                // 登录的访问者如果自己也有授权,取两者中更高的(游客只有链接)
                let own = if grant.guest {
                    None
                } else {
                    self.system.role_of(user, key, now).await?
                };
                let role = own.map_or(grant.role, |own| own.max(grant.role));
                if !role.allows(action) {
                    return Err(KbError::Forbidden(format!(
                        "这个链接的权限是「{}」,不能执行这个操作",
                        role.label()
                    )));
                }
            }
        }
        Ok(())
    }
}

fn now_ms() -> Millis {
    kb_service::llm_gate::today_now_millis()
}

fn text<'a>(args: &'a Value, field: &str) -> Result<&'a str> {
    args.get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| KbError::InvalidInput(format!("缺少参数 {field}")))
}

/// 内容块 / 笔记 id → 资源键。
async fn item_key(runtime: &Embedded, sid: &str, id: &str) -> Result<ResourceKey> {
    if let Some(insight) = InsightRepo::get(runtime.meta.as_ref(), id).await? {
        return ResourceKey::insight(sid, &insight.collection, id);
    }
    for collection in CollectionRepo::list(runtime.meta.as_ref()).await? {
        let rows = runtime
            .store()
            .get(&collection.active_table, &[id.to_owned()])
            .await?;
        if let Some(row) = rows.into_iter().next() {
            return ResourceKey::file(sid, &collection.name, &row.source);
        }
    }
    Err(KbError::NotFound("没有找到这个内容".to_owned()))
}

#[async_trait]
impl ShareGate for SharedGate {
    async fn authorize(
        &self,
        principal: &Principal,
        capability: &str,
        args: &Value,
        space_id: &str,
        link: Option<&LinkGrant>,
    ) -> Result<SharedAccess> {
        let Some(spec) = SPECS.iter().find(|spec| spec.name == capability) else {
            return Err(KbError::Forbidden(
                "这个操作不能在别人分享的内容上进行".to_owned(),
            ));
        };
        if link.is_some_and(|_| !spec.via_link) {
            return Err(KbError::Forbidden(
                "通过分享链接不能进行这个操作".to_owned(),
            ));
        }
        let user = principal.user_id.as_str();
        let now = now_ms();
        // 通过链接访问时,访问者和这个知识库不需要有任何授权关系,权限来自链接
        if link.is_none() {
            // 先用一次便宜的查询挡住「和这个知识库毫无关系的人」:不为陌生人打开别人的数据库
            let related = self.system.space_owner(space_id).await?.as_deref() == Some(user)
                || self.system.has_grant_in_space(user, space_id, now).await?;
            if !related {
                return Err(KbError::NotFound("没有找到这个内容".to_owned()));
            }
        } else if link.is_some_and(|grant| grant.space_id != space_id) {
            return Err(KbError::NotFound("没有找到这个内容".to_owned()));
        }
        let runtime = self.spaces.get(space_id).await?;
        let key = match spec.extract {
            Extract::ItemId => item_key(&runtime, space_id, text(args, "id")?).await?,
            Extract::File => {
                ResourceKey::file(space_id, text(args, "collection")?, text(args, "path")?)?
            }
            Extract::Links => {
                let targets = args
                    .get("targets")
                    .and_then(Value::as_array)
                    .ok_or_else(|| KbError::InvalidInput("缺少参数 targets".to_owned()))?;
                if targets.len() > 200 {
                    return Err(KbError::InvalidInput("一次最多检查 200 个链接".to_owned()));
                }
                // 每个目标单独判断:链接分享只覆盖自己的 root,不能拿一个目标骗过整批。
                for target in targets {
                    // 笔记不在分享 root 的语义里:放行会让分享者私有的笔记标题 / 是否存在泄露出去。
                    // 分享页前端也不会把笔记目标发过来,这里再挡一层。
                    if target.get("kind").and_then(Value::as_str) == Some("note")
                        || target.get("note_id").is_some()
                    {
                        return Err(KbError::Forbidden("分享链接不能检查笔记引用".to_owned()));
                    }
                    let collection = target
                        .get("collection")
                        .and_then(Value::as_str)
                        .ok_or_else(|| {
                            KbError::InvalidInput("链接目标缺少 collection".to_owned())
                        })?;
                    let path = target
                        .get("path")
                        .and_then(Value::as_str)
                        .ok_or_else(|| KbError::InvalidInput("链接目标缺少 path".to_owned()))?;
                    let key = ResourceKey::file(space_id, collection, path)?;
                    self.allow(user, &key, spec.action, link, now).await?;
                }
                let audit: Arc<dyn AuditRepo> = runtime.meta.clone();
                return Ok(SharedAccess {
                    resolved: ResolvedSpace {
                        space_id: space_id.to_owned(),
                        audit,
                        handle: runtime.clone(),
                    },
                    filter: None,
                });
            }
            Extract::Collection => ResourceKey::collection(space_id, text(args, "collection")?)?,
            Extract::Source => {
                let collection = text(args, "collection")?;
                let source = text(args, "source")?;
                match source.strip_prefix("insight:") {
                    Some(id) => ResourceKey::insight(space_id, collection, id)?,
                    None => ResourceKey::file(space_id, collection, source)?,
                }
            }
            Extract::Doc => match args.get("note_id").and_then(Value::as_str) {
                Some(id) => item_key(&runtime, space_id, id).await?,
                None => {
                    ResourceKey::file(space_id, text(args, "collection")?, text(args, "path")?)?
                }
            },
            Extract::Proposal => {
                let proposal = runtime
                    .meta
                    .proposal_get(text(args, "id")?)
                    .await?
                    .ok_or_else(|| KbError::NotFound("没有找到这条建议".to_owned()))?;
                match proposal.target.split_once(':') {
                    Some(("note", id)) => ResourceKey::insight(space_id, &proposal.collection, id)?,
                    Some(("file", path)) => {
                        ResourceKey::file(space_id, &proposal.collection, path)?
                    }
                    _ => return Err(KbError::NotFound("没有找到这条建议".to_owned())),
                }
            }
            Extract::Scope => {
                let collection = text(args, "collection")?;
                match scope_prefix(args) {
                    Some(prefix) => ResourceKey::dir(space_id, collection, &prefix)?,
                    None => ResourceKey::collection(space_id, collection)?,
                }
            }
        };
        self.allow(user, &key, spec.action, link, now).await?;

        let audit: Arc<dyn AuditRepo> = runtime.meta.clone();
        let resolved = ResolvedSpace {
            space_id: space_id.to_owned(),
            audit,
            handle: runtime.clone(),
        };
        let row_filter = if link.is_none() && matches!(spec.extract, Extract::Scope) {
            self.list_filter(user, space_id, &key).await?
        } else {
            None
        };
        // 列表带 `path_prefix` 时,底层是纯字符串前缀匹配:分享了 `docs` 的人会连 `docs2/` 一起列出来。
        // 授权判断是按目录结构做的,所以结果也要按目录边界收一遍(用户和链接都一样)。
        let filter = match (&spec.extract, scope_prefix(args)) {
            (Extract::Scope, Some(prefix)) => Some(within_dir_filter(prefix, row_filter)),
            _ => row_filter,
        };
        Ok(SharedAccess { resolved, filter })
    }
}

/// 请求里的 `path_prefix` 规整成目录(去掉首尾的斜杠);没有或为空就是 `None`(整个集合)。
fn scope_prefix(args: &Value) -> Option<String> {
    args.get("path_prefix")
        .and_then(Value::as_str)
        .map(|prefix| prefix.trim_matches('/'))
        .filter(|prefix| !prefix.is_empty())
        .map(str::to_owned)
}

/// `source` 是不是在目录 `dir` 里面(或者就是它):必须在路径边界上,`docs2/x.md` 不在 `docs` 里。
fn is_within_dir(source: &str, dir: &str) -> bool {
    source == dir
        || source
            .strip_prefix(dir)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// 在原有的行级过滤之外再套一层目录边界过滤:先按边界收,再交给 `inner`。
fn within_dir_filter(dir: String, inner: Option<ResponseFilter>) -> ResponseFilter {
    Arc::new(move |value: Value| {
        let dir = dir.clone();
        let inner = inner.clone();
        Box::pin(async move {
            let mut value = value;
            if let Some(items) = value.get_mut("items").and_then(Value::as_array_mut) {
                let before = items.len();
                // 没有 source 的行无法证明它在目录里:不给
                items.retain(|item| {
                    item.get("source")
                        .and_then(Value::as_str)
                        .is_some_and(|source| is_within_dir(source, &dir))
                });
                let removed = before - items.len();
                if removed > 0 {
                    // 分页是在过滤之前做的:这一页变短、总数也只是估计,告诉界面
                    value["filtered"] = Value::Bool(true);
                    if let Some(total) = value.get("total").and_then(Value::as_u64) {
                        value["total"] = Value::from(total.saturating_sub(removed as u64));
                    }
                }
            }
            match inner {
                Some(inner) => inner(value).await,
                None => Ok(value),
            }
        })
    })
}

impl SharedGate {
    /// 列表结果的行级过滤。只有当范围里确实存在「停止继承」的子级时才需要——
    /// 否则有权看这个范围就等于有权看范围里的每一行(继承),不用为每一行再查一遍权限。
    async fn list_filter(
        &self,
        user: &str,
        space_id: &str,
        scope: &ResourceKey,
    ) -> Result<Option<ResponseFilter>> {
        let Some(collection) = scope.collection_name() else {
            return Ok(None);
        };
        if !self
            .system
            .has_inherit_breaks_in(space_id, collection)
            .await?
        {
            return Ok(None);
        }
        let (system, user, space_id, collection) = (
            self.system.clone(),
            user.to_owned(),
            space_id.to_owned(),
            collection.to_owned(),
        );
        let filter: ResponseFilter = Arc::new(move |value: Value| {
            let (system, user, space_id, collection) = (
                system.clone(),
                user.clone(),
                space_id.clone(),
                collection.clone(),
            );
            Box::pin(async move {
                let mut value = value;
                let Some(items) = value.get_mut("items").and_then(Value::as_array_mut) else {
                    return Ok(value);
                };
                let before = items.len();
                let mut kept = Vec::with_capacity(before);
                for item in std::mem::take(items) {
                    let id = item.get("id").and_then(Value::as_str).unwrap_or_default();
                    let source = item
                        .get("source")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let is_insight = item.get("kind").and_then(Value::as_str) == Some("insight");
                    let key = if is_insight {
                        ResourceKey::insight(&space_id, &collection, id)
                    } else {
                        ResourceKey::file(&space_id, &collection, source)
                    };
                    // 键都构造不出来的行(例如网页来源的网址)无法判断权限:不给
                    let allowed = match key {
                        Ok(key) => system.role_of(&user, &key, now_ms()).await?.is_some(),
                        Err(_) => false,
                    };
                    if allowed {
                        kept.push(item);
                    }
                }
                let removed = before - kept.len();
                *items = kept;
                if removed > 0 {
                    // 分页是在过滤之前做的:这一页变短、总数也只是估计,告诉界面
                    value["filtered"] = Value::Bool(true);
                    if let Some(total) = value.get("total").and_then(Value::as_u64) {
                        value["total"] = Value::from(total.saturating_sub(removed as u64));
                    }
                }
                Ok(value)
            })
        });
        Ok(Some(filter))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn file_menu_is_readable_through_links_but_delete_is_not() {
        let find = |name: &str| SPECS.iter().find(|spec| spec.name == name);
        // 文件菜单只是查询:链接访问者也能看有哪些操作(服务端再按真实角色算 allowed)
        let actions = find("file_actions").expect("file_actions 在白名单里");
        assert!(matches!(actions.action, Action::View));
        assert!(actions.via_link);
        // 删除要 Manager,链接(尤其游客)一律不给
        for name in ["delete_file", "delete_folder"] {
            let spec = find(name).expect("删除能力在白名单里");
            assert!(matches!(spec.action, Action::Delete), "{name}");
            assert!(!spec.via_link, "{name} 不能通过链接调用");
        }
        // 移动 / 回收站只服务于自己的知识库,分享场景不开
        for name in [
            "move_file",
            "move_files",
            "move_folder",
            "list_trash",
            "restore_trash",
            "purge_trash",
        ] {
            assert!(find(name).is_none(), "{name} 不该出现在分享白名单里");
        }
    }

    #[test]
    fn link_check_is_a_read_that_checks_each_target() {
        let spec = SPECS
            .iter()
            .find(|spec| spec.name == "check_links")
            .expect("check_links 在分享白名单里");
        assert!(matches!(spec.action, Action::View));
        assert!(matches!(spec.extract, Extract::Links));
        assert!(spec.via_link);
    }

    #[test]
    fn a_directory_contains_only_its_own_paths() {
        assert!(is_within_dir("docs/a.md", "docs"));
        assert!(is_within_dir("docs/deep/er/a.md", "docs"));
        assert!(is_within_dir("docs", "docs"));
        // 名字以它开头的另一个目录 / 文件不在里面
        assert!(!is_within_dir("docs2/b.md", "docs"));
        assert!(!is_within_dir("docs-private/x.md", "docs"));
        assert!(!is_within_dir("docsx", "docs"));
        assert!(!is_within_dir("other/docs/a.md", "docs"));
        assert!(!is_within_dir("", "docs"));
    }

    #[test]
    fn scope_prefix_is_trimmed_and_empty_means_the_whole_collection() {
        assert_eq!(
            scope_prefix(&json!({"path_prefix": "/docs/"})).as_deref(),
            Some("docs")
        );
        assert_eq!(
            scope_prefix(&json!({"path_prefix": "a/b"})).as_deref(),
            Some("a/b")
        );
        assert_eq!(scope_prefix(&json!({"path_prefix": "/"})), None);
        assert_eq!(scope_prefix(&json!({"path_prefix": ""})), None);
        assert_eq!(scope_prefix(&json!({})), None);
    }

    #[tokio::test]
    async fn the_boundary_filter_drops_rows_outside_the_directory_and_rows_it_cannot_judge() {
        let filter = within_dir_filter("docs".to_owned(), None);
        let out = filter(json!({
            "items": [
                {"id": "1", "source": "docs/a.md"},
                {"id": "2", "source": "docs2/b.md"},
                {"id": "3"},
                {"id": "4", "source": "insight:xyz"},
            ],
            "total": 4,
        }))
        .await
        .unwrap();
        let ids: Vec<&str> = out["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["1"]);
        assert_eq!(out["filtered"], true);
        assert_eq!(out["total"], 1);
    }

    #[tokio::test]
    async fn the_boundary_filter_runs_before_the_inner_row_filter() {
        // 内层过滤只会看到边界里的行
        let inner: ResponseFilter = Arc::new(|value: Value| {
            Box::pin(async move {
                let mut value = value;
                value["inner_saw"] = value["items"].clone();
                Ok(value)
            })
        });
        let filter = within_dir_filter("docs".to_owned(), Some(inner));
        let out = filter(json!({"items": [
            {"id": "1", "source": "docs/a.md"},
            {"id": "2", "source": "docs2/b.md"},
        ]}))
        .await
        .unwrap();
        assert_eq!(out["inner_saw"].as_array().unwrap().len(), 1);
    }
}
