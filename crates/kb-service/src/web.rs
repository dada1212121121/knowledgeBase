//! Web 管理端里**不属于**条目读写与统计的那部分能力。
//!
//! 分工(避免重复实现):
//! - 条目:`crate::items::ItemService`
//! - 统计:`crate::stats::StatsService`
//! - 撤销:`crate::revert::RevertService`
//! - 这里:审计 / 批次列表、令牌管理、删除 collection、读改写配置。
//!
//! 能力注册与权限在 `kb-capability`,组装在 `kb-cli`（设计规范）。

use std::path::PathBuf;
use std::sync::Arc;

use kb_core::config::Config;
use kb_core::model::{AuditEntry, AuditFilter, Batch, Change, Millis, Page};
use kb_core::ports::repo::{AuditRepo, AuthRepo, MetaStore};
use kb_core::ports::{Embedder, VectorStore};
use kb_core::{KbError, Result};

/// 默认分页大小。
pub const DEFAULT_PAGE_SIZE: u32 = 20;
/// 分页上限。
pub const MAX_PAGE_SIZE: u32 = 200;
/// 批次列表里每页最多带多少条变更明细。
const MAX_CHANGES_PER_BATCH: usize = 200;

/// Web 侧的杂项服务。
pub struct WebService {
    meta: Arc<dyn MetaStore>,
    store: Arc<dyn VectorStore>,
    embedder: Arc<dyn Embedder>,
    /// `config.toml` 的路径(`update_config` 写回它)。
    config_file: PathBuf,
}

impl WebService {
    /// 构造。
    pub fn new(
        meta: Arc<dyn MetaStore>,
        store: Arc<dyn VectorStore>,
        embedder: Arc<dyn Embedder>,
        config_file: impl Into<PathBuf>,
    ) -> Self {
        Self {
            meta,
            store,
            embedder,
            config_file: config_file.into(),
        }
    }

    /// 审计列表(分页 + 过滤)。
    pub async fn audit_list(
        &self,
        filter: Option<AuditFilter>,
        page: Page,
    ) -> Result<AuditListResponse> {
        let page = clamp_page(page);
        let entries = AuditRepo::list(self.meta.as_ref(), filter.clone(), page).await?;
        let total = AuditRepo::count(self.meta.as_ref(), filter).await?;
        Ok(AuditListResponse {
            entries,
            total,
            page_size: page.limit,
            offset: page.offset,
        })
    }

    /// 批次列表(新的在前),每个批次带上它的变更明细。
    pub async fn batch_list(&self, page: Page) -> Result<BatchListResponse> {
        let page = clamp_page(page);
        let batches = AuditRepo::list_batches(self.meta.as_ref(), page).await?;
        let total = AuditRepo::count_batches(self.meta.as_ref()).await?;
        let mut items = Vec::with_capacity(batches.len());
        for batch in batches {
            let changes = AuditRepo::changes(self.meta.as_ref(), &batch.id).await?;
            items.push(BatchView::of(batch, changes));
        }
        Ok(BatchListResponse {
            batches: items,
            total,
            page_size: page.limit,
            offset: page.offset,
        })
    }

    /// 新建 API 令牌(明文只返回这一次)。
    pub async fn create_token(&self, name: &str, scope: &str) -> Result<CreatedToken> {
        if name.trim().is_empty() {
            return Err(KbError::InvalidInput("令牌名不能为空".to_owned()));
        }
        if !matches!(scope, "mcp" | "api") {
            return Err(KbError::InvalidInput("scope 只能是 mcp 或 api".to_owned()));
        }
        // 同名令牌会撞 `api_tokens.name` 的唯一约束,先给一句人话
        if AuthRepo::list_api_tokens(self.meta.as_ref())
            .await?
            .iter()
            .any(|token| token.name == name.trim() && token.revoked_at.is_none())
        {
            return Err(KbError::InvalidInput(format!(
                "已经有一个叫 {} 的有效令牌",
                name.trim()
            )));
        }
        let plaintext = format!(
            "{}{}",
            kb_core::token::TOKEN_PREFIX,
            kb_core::token::random_secret()
        );
        let now = now_millis();
        let token = kb_core::model::ApiToken {
            id: uuid::Uuid::now_v7().to_string(),
            name: name.trim().to_owned(),
            token_hash: kb_core::token::sha256_hex(&plaintext),
            scopes: scope.to_owned(),
            created_at: now,
            last_used: None,
            revoked_at: None,
        };
        AuthRepo::create_api_token(self.meta.as_ref(), token.clone()).await?;
        Ok(CreatedToken {
            id: token.id,
            name: token.name,
            scope: token.scopes,
            token: plaintext,
            created_at: now,
        })
    }

    /// 撤销 API 令牌。
    pub async fn revoke_token(&self, id: &str) -> Result<RevokedToken> {
        let now = now_millis();
        AuthRepo::revoke_api_token(self.meta.as_ref(), id, now).await?;
        Ok(RevokedToken {
            id: id.to_owned(),
            revoked_at: now,
        })
    }

    /// 删除 collection(SQLite 行 + 物理表)。
    pub async fn delete_collection(&self, name: &str) -> Result<DeletedCollection> {
        let service = crate::CollectionService::new(
            self.meta.clone(),
            self.store.clone(),
            self.embedder.clone(),
        );
        service.delete(name).await?;
        Ok(DeletedCollection {
            deleted: name.to_owned(),
        })
    }

    /// 当前配置(Web 的 Settings 页按它生成表单)。
    pub async fn get_config(&self) -> Result<Config> {
        // 以文件为准:守护进程起来之后可能有人手改过
        Config::load(&self.config_file)
    }

    /// 改配置:先校验再落盘;**涉及 embedder 的改动只给迁移计划,不写文件**。
    pub async fn update_config(&self, patch: serde_json::Value) -> Result<ConfigUpdate> {
        if !patch.is_object() {
            return Err(KbError::InvalidInput("patch 必须是对象".to_owned()));
        }
        let current = Config::load(&self.config_file)?;
        let mut merged = serde_json::to_value(&current)
            .map_err(|err| KbError::Internal(format!("序列化配置失败: {err}")))?;
        merge_json(&mut merged, &patch);
        let next: Config = serde_json::from_value(merged)
            .map_err(|err| KbError::InvalidInput(format!("配置补丁不合法: {err}")))?;
        next.validate()?;

        // embedder 的改动会改变向量维度,必须走迁移,不能只改文件
        if next.embed != current.embed {
            let plan = self.migration_plan(&current, &next).await?;
            return Ok(ConfigUpdate {
                applied: false,
                restart_required: false,
                changed: Vec::new(),
                config: current,
                migration_plan: Some(plan),
                notes: vec![
                    "embed 段的改动不会立即生效:先用 `kb migrate` 迁移已有 collection,再改配置"
                        .to_owned(),
                ],
            });
        }

        let changed = changed_sections(&current, &next);
        if changed.is_empty() {
            return Ok(ConfigUpdate {
                applied: false,
                restart_required: false,
                changed,
                config: current,
                migration_plan: None,
                notes: vec!["补丁与当前配置一致,没有写入".to_owned()],
            });
        }
        write_config_atomically(&self.config_file, &next)?;
        // 哪些段要重启,按热更新白名单算(不再一律写“要重启”)
        let diff = current.diff(&next);
        let restart_keys = diff.restart_required();
        let hot_keys = diff.hot();
        let notes = if restart_keys.is_empty() {
            vec![format!("配置已写入并热更新:{}", hot_keys.join(", "))]
        } else {
            vec![format!(
                "配置已写入;{} 立即生效,{} 需要重启 `kb daemon`",
                hot_keys.join(", "),
                restart_keys.join(", ")
            )]
        };
        Ok(ConfigUpdate {
            applied: true,
            restart_required: !restart_keys.is_empty(),
            changed,
            config: next,
            migration_plan: None,
            notes,
        })
    }

    /// embedder 改动的迁移计划(不执行迁移,只告诉调用方要做什么)。
    async fn migration_plan(&self, current: &Config, next: &Config) -> Result<MigrationPlan> {
        let collections = kb_core::ports::repo::CollectionRepo::list(self.meta.as_ref()).await?;
        Ok(MigrationPlan {
            from: format!("{}:{}", current.embed.backend, current.embed.model),
            to: format!("{}:{}", next.embed.backend, next.embed.model),
            same_compat_group: current.embed.same_compat_group(&next.embed),
            collections: collections
                .into_iter()
                .map(|collection| PlannedCollection {
                    name: collection.name,
                    embedder_id: collection.embedder_id,
                    dim: collection.dim,
                })
                .collect(),
        })
    }
}

/// `audit_list` 的结果。
#[derive(Clone, Debug, serde::Serialize)]
pub struct AuditListResponse {
    /// 本页条目。
    pub entries: Vec<AuditEntry>,
    /// 过滤后的总条数。
    pub total: u64,
    /// 每页条数。
    pub page_size: u32,
    /// 跳过条数。
    pub offset: u32,
}

/// 批次列表里的一个批次。
#[derive(Clone, Debug, serde::Serialize)]
pub struct BatchView {
    /// 批次本身。
    #[serde(flatten)]
    pub batch: Batch,
    /// 变更明细(`op` 从 `after_json` 里解析,包装层的占位没有 `op`)。
    pub changes: Vec<ChangeView>,
}

impl BatchView {
    fn of(batch: Batch, changes: Vec<Change>) -> Self {
        let changes = changes
            .into_iter()
            .take(MAX_CHANGES_PER_BATCH)
            .map(|change| {
                let op = serde_json::from_str::<serde_json::Value>(&change.after_json)
                    .ok()
                    .and_then(|value| {
                        value
                            .get("op")
                            .and_then(|op| op.as_str())
                            .map(str::to_owned)
                    });
                let revertible = op.is_some();
                ChangeView {
                    seq: change.seq,
                    target: change.target,
                    op,
                    revertible,
                }
            })
            .collect();
        Self { batch, changes }
    }
}

/// 一条变更的摘要。
#[derive(Clone, Debug, serde::Serialize)]
pub struct ChangeView {
    /// 批次内序号。
    pub seq: u32,
    /// 目标。
    pub target: String,
    /// 操作类型(包装层的占位记录没有)。
    pub op: Option<String>,
    /// 是否能被 `revert_batch` 撤销。
    pub revertible: bool,
}

/// `batch_list` 的结果。
#[derive(Clone, Debug, serde::Serialize)]
pub struct BatchListResponse {
    /// 本页批次。
    pub batches: Vec<BatchView>,
    /// 批次总数。
    pub total: u64,
    /// 每页条数。
    pub page_size: u32,
    /// 跳过条数。
    pub offset: u32,
}

/// `create_token` 的结果(明文只出现一次)。
#[derive(Clone, Debug, serde::Serialize)]
pub struct CreatedToken {
    /// 令牌 id。
    pub id: String,
    /// 名字。
    pub name: String,
    /// `mcp` / `api`。
    pub scope: String,
    /// 明文令牌。
    pub token: String,
    /// 创建时间。
    pub created_at: Millis,
}

/// `revoke_token` 的结果。
#[derive(Clone, Debug, serde::Serialize)]
pub struct RevokedToken {
    /// 令牌 id。
    pub id: String,
    /// 撤销时间。
    pub revoked_at: Millis,
}

/// `delete_collection` 的结果。
#[derive(Clone, Debug, serde::Serialize)]
pub struct DeletedCollection {
    /// 被删的 collection。
    pub deleted: String,
}

/// `update_config` 的结果。
#[derive(Clone, Debug, serde::Serialize)]
pub struct ConfigUpdate {
    /// 是否真的写进了 `config.toml`。
    pub applied: bool,
    /// 是否需要重启守护进程。
    pub restart_required: bool,
    /// 改动了的配置段。
    pub changed: Vec<String>,
    /// 落盘后的配置(未落盘时是当前配置)。
    pub config: Config,
    /// 涉及 embedder 时的迁移计划。
    pub migration_plan: Option<MigrationPlan>,
    /// 给调用方的说明。
    pub notes: Vec<String>,
}

/// 迁移计划(只描述,不执行)。
#[derive(Clone, Debug, serde::Serialize)]
pub struct MigrationPlan {
    /// 当前 embedder(`backend:model`)。
    pub from: String,
    /// 目标 embedder。
    pub to: String,
    /// 是否同一兼容组(同组可以只改 `embedder_id`,不必重嵌入)。
    pub same_compat_group: bool,
    /// 受影响的 collection。
    pub collections: Vec<PlannedCollection>,
}

/// 迁移计划里的一个 collection。
#[derive(Clone, Debug, serde::Serialize)]
pub struct PlannedCollection {
    /// 名字。
    pub name: String,
    /// 当前 embedder。
    pub embedder_id: String,
    /// 当前维度。
    pub dim: usize,
}

/// 把 `patch` 深合并进 `target`(对象逐键递归,其它类型直接替换)。
fn merge_json(target: &mut serde_json::Value, patch: &serde_json::Value) {
    match (target, patch) {
        (serde_json::Value::Object(target), serde_json::Value::Object(patch)) => {
            for (key, value) in patch {
                // `null` 表示“删掉这个键”(JSON Merge Patch 语义):
                // 没有它,`search.collection_weights` 这类 map 只能加不能撤,
                // 反馈调权的回滚会变成空操作。
                //
                // 注意:对**标量**同样生效——`{"search":{"k":null}}` 会删掉 `k`,
                // 反序列化时按 `#[serde(default)]` 回到默认值(不是校验错误,)。
                if value.is_null() {
                    target.remove(key);
                    continue;
                }
                match target.get_mut(key) {
                    Some(slot) => merge_json(slot, value),
                    None => {
                        target.insert(key.clone(), value.clone());
                    }
                }
            }
        }
        (target, patch) => *target = patch.clone(),
    }
}

/// 哪些配置段变了。
///
/// **不再手写顶层段清单**:`update_config` 靠这个列表判断“有没有变化”,手写清单漏一段
/// 就会出现“补丁写进去了但回执说没有变化、文件也没写”—— 加 `skills`、
/// 加 `backup` 时各踩到一次。这里改用 [`Config::diff`](kb_core::config::Config::diff)
/// (逐叶子键)反推顶层段,新增配置段不可能再漏。
fn changed_sections(current: &Config, next: &Config) -> Vec<String> {
    let mut sections: Vec<String> = current
        .diff(next)
        .changes
        .iter()
        .filter_map(|change| change.key.split('.').next())
        .map(str::to_owned)
        .collect();
    sections.sort();
    sections.dedup();
    sections
}

/// 原子写配置:先写同目录临时文件再 rename,避免写一半留下坏文件。
fn write_config_atomically(path: &std::path::Path, config: &Config) -> Result<()> {
    let text = toml::to_string_pretty(config)
        .map_err(|err| KbError::Internal(format!("序列化配置失败: {err}")))?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| {
            KbError::Internal(format!("创建目录 {} 失败: {err}", parent.display()))
        })?;
    }
    let temp = path.with_extension("toml.tmp");
    std::fs::write(&temp, text)
        .map_err(|err| KbError::Internal(format!("写 {} 失败: {err}", temp.display())))?;
    std::fs::rename(&temp, path).map_err(|err| {
        let _ = std::fs::remove_file(&temp);
        KbError::Internal(format!("替换 {} 失败: {err}", path.display()))
    })?;
    Ok(())
}

fn clamp_page(page: Page) -> Page {
    Page::new(page.limit.clamp(1, MAX_PAGE_SIZE), page.offset)
}

fn now_millis() -> Millis {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_patch_treats_null_as_removal() {
        // 质量检查 :回滚要能删掉本次新增的键;没有 null 语义的话 map 只能加不能撤
        let mut target = serde_json::json!({
            "search": { "collection_weights": { "proj_a": 1.1, "proj_b": 0.9 } }
        });
        let patch = serde_json::json!({
            "search": { "collection_weights": { "proj_a": 1.0, "proj_b": null } }
        });
        merge_json(&mut target, &patch);
        assert_eq!(target["search"]["collection_weights"]["proj_a"], 1.0);
        assert!(
            target["search"]["collection_weights"]
                .get("proj_b")
                .is_none(),
            "{target}"
        );
    }

    #[test]
    fn merge_patch_keeps_untouched_keys() {
        let mut target = serde_json::json!({ "search": { "k": 8, "global_weight": 0.8 } });
        merge_json(&mut target, &serde_json::json!({ "search": { "k": 9 } }));
        assert_eq!(target["search"]["k"], 9);
        assert_eq!(target["search"]["global_weight"], 0.8);
    }

    #[test]
    fn every_config_section_shows_up_in_the_change_receipt() {
        // 曾经的阻塞项:`backup` 段加进 `Config` 后忘了加进手写清单,补丁写不进去、
        // 回执还说“没有变化”。现在段名从 `Config::diff` 反推,而且这张补丁表必须覆盖
        // `Config` 的**全部**顶层字段 —— 新增配置段时忘了登记,下面的断言会红。
        let base = Config::default();
        assert!(
            changed_sections(&base, &base).is_empty(),
            "配置没变时不该报任何段"
        );

        let patches: [(&str, serde_json::Value); 30] = [
            ("server", serde_json::json!({ "allow_remote": true })),
            (
                "paths",
                serde_json::json!({ "models_dir": "/tmp/kb-qc-models" }),
            ),
            ("network", serde_json::json!({ "hf_cdn_direct": false })),
            ("embed", serde_json::json!({ "batch_size": 4 })),
            ("rerank", serde_json::json!({ "top_n": 7 })),
            ("accel", serde_json::json!({ "enabled": true })),
            ("index", serde_json::json!({ "watch": false })),
            ("search", serde_json::json!({ "k": 3 })),
            (
                "mcp",
                serde_json::json!({ "transports": ["stdio", "http"] }),
            ),
            ("llm", serde_json::json!({ "max_calls_per_hour": 5 })),
            ("evolution", serde_json::json!({ "review_mode": "human" })),
            (
                "schedule",
                serde_json::json!({ "optimize_interval_minutes": 30 }),
            ),
            ("backup", serde_json::json!({ "keep_count": 1 })),
            ("retention", serde_json::json!({ "jobs_days": 7 })),
            ("meta", serde_json::json!({ "read_pool": 2 })),
            ("upload", serde_json::json!({ "chunk_mb": 4 })),
            ("extract", serde_json::json!({ "ocr_enabled": true })),
            ("convert", serde_json::json!({ "enabled": true })),
            ("office", serde_json::json!({ "keep_versions": 5 })),
            ("skills", serde_json::json!({ "allow_exec": true })),
            ("log", serde_json::json!({ "level": "debug" })),
            ("ai", serde_json::json!({ "acp": false })),
            ("accounts", serde_json::json!({ "require_invite": true })),
            ("admin", serde_json::json!({ "inspect_enabled": false })),
            ("quota", serde_json::json!({ "storage_gb": 50 })),
            ("share", serde_json::json!({ "allow_guest_edit": true })),
            ("site", serde_json::json!({ "name": "我的知识库" })),
            ("mail", serde_json::json!({ "enabled": true })),
            ("web_extract", serde_json::json!({ "max_parts": 2 })),
            // 加了 `[editor]` 段却没登记到这张表,守卫一直是红的
            ("editor", serde_json::json!({ "extensions": true })),
        ];

        // 表必须覆盖 `Config` 序列化出来的全部顶层键(漏一段就说明守卫不全)
        let mut fields: Vec<String> = serde_json::to_value(&base)
            .expect("序列化配置")
            .as_object()
            .expect("配置是对象")
            .keys()
            .cloned()
            .collect();
        fields.sort();
        let mut covered: Vec<String> = patches.iter().map(|(name, _)| (*name).to_owned()).collect();
        covered.sort();
        assert_eq!(
            covered, fields,
            "段清单与 Config 的顶层字段不一致:新增配置段要在测试里补一条补丁"
        );

        for (section, patch) in patches {
            let mut merged = serde_json::to_value(&base).expect("序列化配置");
            let mut one = serde_json::Map::new();
            one.insert(section.to_owned(), patch);
            merge_json(&mut merged, &serde_json::Value::Object(one));
            let mutated: Config = serde_json::from_value(merged).expect("反序列化配置");
            assert_eq!(
                changed_sections(&base, &mutated),
                vec![section.to_owned()],
                "改了 {section} 段,回执里应当且只应当出现它"
            );
        }
    }
}
