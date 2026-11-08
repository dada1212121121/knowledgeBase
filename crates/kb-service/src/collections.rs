//! Collection 管理（设计规范）。
//!
//! - 启动时确保 `_global` 存在;
//! - 创建 collection 时同时写 SQLite(`collections` 表)与 LanceDB(`ensure_table`);
//! - 物理表名按设计规范生成:`{collection}__{embedder_slug}__v{n}`。

use std::sync::Arc;

use kb_core::filter::Filter;
use kb_core::ids::{GLOBAL_COLLECTION, embedder_slug, table_name, validate_collection_name};
use kb_core::model::{Collection, CollectionKind, ContextMode, ItemStatus, Millis};
use kb_core::ports::repo::{CollectionRepo, MetaStore};
use kb_core::ports::{Embedder, VectorStore};
use kb_core::{KbError, Result};

/// 列出 collection 时返回的摘要(`list_collections` 能力的 `data` 结构)。
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct CollectionInfo {
    /// collection 名。
    pub name: String,
    /// 种类。
    pub kind: CollectionKind,
    /// 所属项目。
    pub project_id: Option<String>,
    /// 当前 embedder。
    pub embedder_id: String,
    /// 向量维度。
    pub dim: usize,
    /// 物理表。
    pub active_table: String,
    /// 向量库行数(块数)。
    pub rows: u64,
    /// 可浏览的条目数(启用状态的文件 + 笔记,一份文档的几十个块只算一个),和知识库列表里的“全部”一致。
    pub items: u64,
    /// 迁移目标表。
    pub migrating_to: Option<String>,
}

/// Collection 管理服务。
pub struct CollectionService {
    meta: Arc<dyn MetaStore>,
    store: Arc<dyn VectorStore>,
    embedder: Arc<dyn Embedder>,
}

impl CollectionService {
    /// 用注入的端口构造。
    pub fn new(
        meta: Arc<dyn MetaStore>,
        store: Arc<dyn VectorStore>,
        embedder: Arc<dyn Embedder>,
    ) -> Self {
        Self {
            meta,
            store,
            embedder,
        }
    }

    /// 启动时确保 `_global` 存在(幂等)。
    pub async fn ensure_global(&self) -> Result<Collection> {
        if let Some(existing) = CollectionRepo::get(self.meta.as_ref(), GLOBAL_COLLECTION).await? {
            return Ok(existing);
        }
        self.create(GLOBAL_COLLECTION, CollectionKind::Global, None)
            .await
    }

    /// 补回 SQLite 里有、向量库里却没有的物理表。
    ///
    /// 从备份恢复后就是这个状态:`lance/` 不在归档里,而 `collections` 表(元数据库)还认得每个集合。
    /// 不补的话 `list_collections` / 读条目会直接报「表不存在」,整个知识库用不了。
    /// 只建**空表**;里面的内容由调用方重新投递嵌入(经验条目)或让用户 `kb index --full`(项目文件)。
    /// 返回这次补了表的集合。
    pub async fn heal_tables(&self) -> Result<Vec<Collection>> {
        let mut healed = Vec::new();
        for collection in CollectionRepo::list(self.meta.as_ref()).await? {
            match self.store.count(&collection.active_table, None).await {
                Ok(_) => {
                    // 表在也要走一次 ensure_table:升级后新增的可空列(例如文本优先索引的
                    // `embed_state`)只有建表时才会补,不补的话旧库一写入就缺列。
                    self.store
                        .ensure_table(&collection.active_table, collection.dim)
                        .await?;
                }
                Err(KbError::NotFound(_)) => {
                    self.store
                        .ensure_table(&collection.active_table, collection.dim)
                        .await?;
                    healed.push(collection);
                }
                Err(err) => return Err(err),
            }
        }
        Ok(healed)
    }

    /// 为项目创建 `proj_<slug>` collection(注册项目时调用)。
    pub async fn create_for_project(
        &self,
        project_id: &str,
        project_name: &str,
    ) -> Result<Collection> {
        let name = format!("proj_{}", kb_core::ids::project_slug(project_name));
        self.create(&name, CollectionKind::Project, Some(project_id))
            .await
    }

    /// 创建 collection:先建物理表,再写 SQLite。
    pub async fn create(
        &self,
        name: &str,
        kind: CollectionKind,
        project_id: Option<&str>,
    ) -> Result<Collection> {
        validate_collection_name(name)?;
        if CollectionRepo::get(self.meta.as_ref(), name)
            .await?
            .is_some()
        {
            return Err(KbError::InvalidInput(format!("collection {name} 已存在")));
        }
        // 同名重建:把上一次删集合时可能留下的孤儿行清掉(旧版本没有级联清理),
        // 否则增量 diff 会把这些 chunks 当成“没变”而跳过,新表永远是空的。
        CollectionRepo::purge_data(self.meta.as_ref(), name).await?;
        let embedder_id = self.embedder.id().to_owned();
        let dim = self.embedder.dim();
        let table = table_name(name, &embedder_slug(&embedder_id), 1)?;
        self.store.ensure_table(&table, dim).await?;
        let collection = Collection {
            name: name.to_owned(),
            kind,
            project_id: project_id.map(str::to_owned),
            embedder_id,
            dim,
            active_table: table,
            table_version: 1,
            migrating_to: None,
            migration_started_at: None,
            retired_tables: Vec::new(),
            context_mode: ContextMode::Header,
            created_at: now_millis(),
        };
        if let Err(err) = CollectionRepo::create(self.meta.as_ref(), collection.clone()).await {
            // SQLite 写失败时把刚建的物理表删掉,避免留下孤儿表
            if let Err(drop_err) = self.store.drop_table(&collection.active_table).await {
                tracing::warn!(table = %collection.active_table, error = %drop_err, "回滚物理表失败");
            }
            return Err(err);
        }
        Ok(collection)
    }

    /// 取单个 collection。
    pub async fn get(&self, name: &str) -> Result<Option<Collection>> {
        CollectionRepo::get(self.meta.as_ref(), name).await
    }

    /// 列出全部 collection 及各自行数。
    pub async fn list(&self) -> Result<Vec<CollectionInfo>> {
        let collections = CollectionRepo::list(self.meta.as_ref()).await?;
        let mut infos = Vec::with_capacity(collections.len());
        for collection in collections {
            let rows = self.store.count(&collection.active_table, None).await?;
            let items = browsable_items(self.store.as_ref(), &collection.active_table).await?;
            infos.push(CollectionInfo {
                name: collection.name,
                kind: collection.kind,
                project_id: collection.project_id,
                embedder_id: collection.embedder_id,
                dim: collection.dim,
                active_table: collection.active_table,
                rows,
                items,
                migrating_to: collection.migrating_to,
            });
        }
        Ok(infos)
    }

    /// 删除 collection:先删 SQLite 记录(权威数据),再尽力删物理表。
    ///
    /// 物理表删除失败只记 warn:此时 SQLite 里已经没有指向它的指针,删不掉只会留下
    /// 孤儿表,由夜间维护清理;反过来(先删表后删记录)失败会留下指向空表的指针,
    /// 更糟。
    pub async fn delete(&self, name: &str) -> Result<()> {
        let collection = CollectionRepo::get(self.meta.as_ref(), name)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("collection {name}")))?;
        CollectionRepo::delete(self.meta.as_ref(), name).await?;
        let tables = std::iter::once(collection.active_table).chain(collection.retired_tables);
        for table in tables {
            match self.store.drop_table(&table).await {
                Ok(()) | Err(KbError::NotFound(_)) => {}
                Err(err) => {
                    tracing::warn!(table = %table, error = %err, "删除物理表失败,留下孤儿表待维护任务清理");
                }
            }
        }
        Ok(())
    }
}

fn now_millis() -> Millis {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

/// 一张表里可浏览的条目数:启用状态的文件 + 笔记,按文件归并(同一份文档的几十个块只算一个)。
///
/// 界面上写“多少条”都应该是这个数,不是向量库的块数。过滤条件和知识库列表的默认视图一致,
/// 所以与浏览器共用 `LanceStore` 里按表版本失效的缓存:没有写入时是内存里取个长度,
/// 一个 13.5 万块的集合冷读也只要 0.16 秒。
pub async fn browsable_items(store: &dyn VectorStore, table: &str) -> Result<u64> {
    let filter = Filter {
        statuses: vec![ItemStatus::Active],
        ..Filter::default()
    }
    .to_sql()?;
    Ok(store.list_files(table, filter.as_deref()).await?.len() as u64)
}
