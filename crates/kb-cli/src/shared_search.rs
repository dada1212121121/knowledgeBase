//! 共享范围检索(多用户设计说明):在别人分享给我的内容里搜,可以连同自己的一起搜。
//!
//! 做法:
//! 1. 把我的授权按知识库分组(最多 [`MAX_SPACES`] 个来源,授权到单篇的最多 [`MAX_DOC_GRANTS`] 个,超了提示缩小范围);
//! 2. 每个知识库按授权范围拆成几次检索:整库 / 集合级授权搜整个集合,文件夹和文件级授权用 `path:` 前缀限定,
//!    笔记级授权限定在那个集合里的 `kind:insight`,命中后只留下授权里的那几条;
//! 3. **每一条命中都再算一次有效角色**——限定范围只是为了召回和效率,真正的授权保证在这一步:
//!    停止继承的子级、过期的授权、范围里混进来的别人的文件,都在这里被挡掉;
//! 4. 各次检索的排序用 RRF 合并(不同知识库的分数不可比,只比名次)。

use std::collections::{BTreeMap, HashSet};

use kb_capability::CallCtx;
use kb_capability::admin::SearchSharedArgs;
use kb_core::ports::repo::CollectionRepo;
use kb_core::rrf::{RankedList, weighted_rrf};
use kb_core::share::{DocRef, ResourceKey};
use kb_core::{KbError, Result};
use kb_service::{SearchOptions, SearchRequest, SearchService};
use serde_json::{Value, json};

use crate::admin_backend::SystemAdmin;
use crate::runtime::Embedded;

/// 一次最多搜多少个来源知识库。
pub const MAX_SPACES: usize = 20;
/// 授权到单篇文档的最多多少个(超出提示缩小范围)。
pub const MAX_DOC_GRANTS: usize = 2000;
/// 每个来源默认的返回条数上限(过滤前多取几倍,过滤后再截断)。
const OVERFETCH: usize = 4;

/// 一次具体的检索。
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct Probe {
    space_id: String,
    collection: String,
    /// `path:` 前缀(文件夹 / 文件级授权)。
    prefix: Option<String>,
    /// 只要笔记(笔记级授权)。
    insight_only: bool,
}

/// 把我在一个知识库里的授权根变成要做的检索。窄的并进宽的:集合级授权已经覆盖了集合里的一切,
/// 就不用再为里面的文件夹单独搜一遍。
fn probes_for(space_id: &str, roots: &[ResourceKey], all_collections: &[String]) -> Vec<Probe> {
    let mut whole: HashSet<String> = HashSet::new();
    for root in roots {
        match root {
            ResourceKey::Space { .. } => whole.extend(all_collections.iter().cloned()),
            ResourceKey::Collection { name, .. } => {
                whole.insert(name.clone());
            }
            _ => {}
        }
    }
    let mut probes: Vec<Probe> = whole
        .iter()
        .map(|collection| Probe {
            space_id: space_id.to_owned(),
            collection: collection.clone(),
            prefix: None,
            insight_only: false,
        })
        .collect();
    for root in roots {
        let probe = match root {
            ResourceKey::Dir { name, path, .. } => Probe {
                space_id: space_id.to_owned(),
                collection: name.clone(),
                prefix: Some(path.clone()),
                insight_only: false,
            },
            ResourceKey::Doc {
                name,
                doc: DocRef::File(path),
                ..
            } => Probe {
                space_id: space_id.to_owned(),
                collection: name.clone(),
                prefix: Some(path.clone()),
                insight_only: false,
            },
            ResourceKey::Doc {
                name,
                doc: DocRef::Insight(_),
                ..
            } => Probe {
                space_id: space_id.to_owned(),
                collection: name.clone(),
                prefix: None,
                insight_only: true,
            },
            _ => continue,
        };
        if !whole.contains(&probe.collection) && !probes.contains(&probe) {
            probes.push(probe);
        }
    }
    probes.sort_by(|a, b| {
        (&a.collection, &a.prefix, a.insight_only).cmp(&(&b.collection, &b.prefix, b.insight_only))
    });
    probes
}

fn search_service(runtime: &Embedded) -> SearchService {
    SearchService::new(
        runtime.meta.clone(),
        runtime.store(),
        runtime.embedder.clone(),
        crate::runtime::build_reranker(&runtime.config()),
        SearchOptions::from_config(&runtime.config()),
    )
    // 共享检索同样要排队:它跑的是同一批核
    .with_gate(runtime.search_gate.clone())
    .with_query_cache(runtime.query_cache.clone())
    .with_pending_cache(runtime.pending_cache.clone())
}

impl SystemAdmin {
    pub(crate) async fn do_search_shared(
        &self,
        ctx: &CallCtx,
        args: SearchSharedArgs,
    ) -> Result<Value> {
        let (me, own) = Self::share_actor(ctx)?;
        let deps = self.share_deps()?;
        let query = args.query.trim().to_owned();
        if query.is_empty() {
            return Err(KbError::InvalidInput("检索词不能为空".to_owned()));
        }
        let k = args.k.unwrap_or(8).clamp(1, 50) as usize;
        let include_own = match args.scope.as_deref() {
            None | Some("shared") => false,
            Some("all") => true,
            Some(other) => {
                return Err(KbError::InvalidInput(format!(
                    "scope 只能是 shared / all,收到 {other:?}"
                )));
            }
        };
        let now = kb_service::llm_gate::today_now_millis();
        let roots = self.system.shared_with(&me, true, now).await?;
        // 按知识库分组(BTreeMap:顺序稳定,结果可复现)
        let mut by_space: BTreeMap<String, Vec<ResourceKey>> = BTreeMap::new();
        let mut doc_grants = 0;
        for root in roots {
            if let Some(only) = args.space_id.as_deref()
                && root.grant.space_id != only
            {
                continue;
            }
            let Ok(key) = ResourceKey::parse(&root.grant.resource_key) else {
                continue;
            };
            if matches!(key, ResourceKey::Doc { .. }) {
                doc_grants += 1;
            }
            by_space
                .entry(root.grant.space_id.clone())
                .or_default()
                .push(key);
        }
        if by_space.len() > MAX_SPACES {
            return Err(KbError::InvalidInput(format!(
                "共享给你的来源有 {} 个,一次最多搜 {MAX_SPACES} 个,请选一个人再搜",
                by_space.len()
            )));
        }
        if doc_grants > MAX_DOC_GRANTS {
            return Err(KbError::InvalidInput(format!(
                "授权到单篇文档的有 {doc_grants} 篇,超过 {MAX_DOC_GRANTS},请缩小范围(选一个人或一个文件夹)"
            )));
        }

        // (标签, 来源信息, 命中列表) — 每次检索一个有序列表
        let mut lists: Vec<(String, Vec<(String, Value)>)> = Vec::new();
        let mut sources = Vec::new();
        for (space_id, space_roots) in &by_space {
            let runtime = deps.spaces.get(space_id).await?;
            let collections: Vec<String> = CollectionRepo::list(runtime.meta.as_ref())
                .await?
                .into_iter()
                .map(|c| c.name)
                .collect();
            let owner = match self.system.space_owner(space_id).await? {
                Some(id) => self.profile_of(&id).await,
                None => None,
            };
            let service = search_service(&runtime);
            let mut found = 0;
            for probe in probes_for(space_id, space_roots, &collections) {
                let mut text = query.clone();
                if let Some(prefix) = &probe.prefix {
                    text.push_str(&format!(" path:{prefix}"));
                }
                if probe.insight_only {
                    text.push_str(" kind:insight");
                }
                let response = service
                    .search(SearchRequest {
                        query: text,
                        collections: vec![probe.collection.clone()],
                        k: Some(k * OVERFETCH),
                        explain: false,
                        rerank: None,
                    })
                    .await?;
                let mut ranked = Vec::new();
                for hit in response.hits {
                    // 真正的授权保证:每条命中重新算有效角色
                    let key = if hit.kind == kb_core::model::RecordKind::Insight {
                        ResourceKey::insight(space_id, &hit.collection, &hit.id)
                    } else {
                        ResourceKey::file(space_id, &hit.collection, &hit.source)
                    };
                    let Ok(key) = key else { continue };
                    let Some(role) = self.system.role_of(&me, &key, now).await? else {
                        continue;
                    };
                    let mut row = serde_json::to_value(&hit)
                        .map_err(|err| KbError::Internal(format!("序列化命中失败:{err}")))?;
                    row["space_id"] = json!(space_id);
                    row["owner"] = json!(owner);
                    row["role"] = json!(role);
                    ranked.push((format!("{space_id}\u{1f}{}", hit.id), row));
                }
                found += ranked.len();
                lists.push((format!("{space_id}/{}", probe.collection), ranked));
            }
            sources.push(json!({ "space_id": space_id, "owner": owner, "hits": found }));
        }
        if include_own && let Some(own_space) = own {
            let runtime = deps.spaces.get(&own_space).await?;
            let collections: Vec<String> = CollectionRepo::list(runtime.meta.as_ref())
                .await?
                .into_iter()
                .map(|c| c.name)
                .collect();
            let response = search_service(&runtime)
                .search(SearchRequest {
                    query: query.clone(),
                    collections,
                    k: Some(k * OVERFETCH),
                    explain: false,
                    rerank: None,
                })
                .await?;
            let ranked = response
                .hits
                .into_iter()
                .filter_map(|hit| {
                    let mut row = serde_json::to_value(&hit).ok()?;
                    row["space_id"] = json!(own_space);
                    row["role"] = json!("owner");
                    Some((format!("{own_space}\u{1f}{}", hit.id), row))
                })
                .collect::<Vec<_>>();
            sources.push(
                json!({ "space_id": own_space, "owner": null, "hits": ranked.len(), "mine": true }),
            );
            lists.push((format!("{own_space}/mine"), ranked));
        }

        // 各次检索的名次用 RRF 合并(不同知识库的分数不可比)
        let id_lists: Vec<Vec<String>> = lists
            .iter()
            .map(|(_, rows)| rows.iter().map(|(id, _)| id.clone()).collect())
            .collect();
        let ranked_lists: Vec<RankedList<'_>> = id_lists
            .iter()
            .map(|ids| RankedList { ids, weight: 1.0 })
            .collect();
        let fused = weighted_rrf(&ranked_lists, 60);
        let mut rows = std::collections::HashMap::new();
        for (_, list) in lists {
            for (id, row) in list {
                rows.entry(id).or_insert(row);
            }
        }
        let hits: Vec<Value> = fused
            .into_iter()
            .take(k)
            .filter_map(|entry| rows.remove(&entry.id))
            .collect();
        Ok(json!({ "hits": hits, "sources": sources, "query": query }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SID: &str = "sp_alice0000";

    fn probes(roots: Vec<ResourceKey>, collections: &[&str]) -> Vec<Probe> {
        let collections: Vec<String> = collections.iter().map(|c| (*c).to_owned()).collect();
        probes_for(SID, &roots, &collections)
    }

    #[test]
    fn a_whole_space_grant_searches_every_collection_and_swallows_narrower_ones() {
        let got = probes(
            vec![
                ResourceKey::space(SID).unwrap(),
                ResourceKey::dir(SID, "a", "docs").unwrap(),
            ],
            &["a", "b"],
        );
        assert_eq!(got.len(), 2, "{got:?}");
        assert!(got.iter().all(|p| p.prefix.is_none() && !p.insight_only));
    }

    #[test]
    fn narrow_grants_become_narrow_probes_and_collection_grants_cover_their_own_children() {
        let got = probes(
            vec![
                ResourceKey::collection(SID, "wide").unwrap(),
                ResourceKey::dir(SID, "wide", "inner").unwrap(),
                ResourceKey::dir(SID, "narrow", "docs").unwrap(),
                ResourceKey::file(SID, "narrow", "solo/one.md").unwrap(),
                ResourceKey::insight(SID, "notes", "n1").unwrap(),
                ResourceKey::insight(SID, "notes", "n2").unwrap(),
            ],
            &["wide", "narrow", "notes"],
        );
        let describe: Vec<(String, Option<String>, bool)> = got
            .iter()
            .map(|p| (p.collection.clone(), p.prefix.clone(), p.insight_only))
            .collect();
        assert_eq!(
            describe,
            [
                ("narrow".into(), Some("docs".into()), false),
                ("narrow".into(), Some("solo/one.md".into()), false),
                ("notes".into(), None, true),
                ("wide".into(), None, false),
            ],
            "wide/inner 并进了 wide;两条笔记授权合成一次检索"
        );
    }

    #[test]
    fn no_grants_means_nothing_to_search() {
        assert!(probes(vec![], &["a"]).is_empty());
    }
}
