//! 多人在线编辑在守护进程里的落地:协作状态存哪、正文怎么读写、保存点怎么生成。
//!
//! 房间(`kb-collab`)不认识知识库:它只拿到一个资源键。这里按键里的知识库 id 找到那个知识库的运行时,
//! 协作状态存进**它自己的** `meta.db`,正文也写回**它自己的**笔记 / 文件——和单人编辑走同一批服务,
//! 所以配额、检索、版本历史的行为都和原来一致。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use kb_collab::{Body, CollabHooks, CollabStore, DocKind, DocRef, Landing, Participant, StoredDoc};
use kb_core::model::Millis;
use kb_core::share::{DocRef as ShareDoc, ResourceKey};
use kb_core::{KbError, Result};

use crate::runtime::Embedded;
use crate::spaces::SpaceRegistry;

/// 落地之后多久没有新变化才重新嵌入(设计规范第 5 步):别边打字边重算向量。
pub const REINDEX_DEBOUNCE: Duration = Duration::from_secs(30);

/// 协作的存储与落地。同一个对象同时实现 [`CollabStore`] 和 [`CollabHooks`]。
pub struct CollabBackend {
    spaces: Arc<SpaceRegistry>,
    debounce: Duration,
    /// 每篇文档至多一个等待中的重新索引;又有落地就重新计时。
    pending: Mutex<HashMap<String, tokio::task::JoinHandle<()>>>,
}

impl CollabBackend {
    /// 构造。
    pub fn new(spaces: Arc<SpaceRegistry>) -> Arc<Self> {
        Self::with_debounce(spaces, REINDEX_DEBOUNCE)
    }

    /// 指定重新索引的去抖时间(测试里缩短)。
    pub fn with_debounce(spaces: Arc<SpaceRegistry>, debounce: Duration) -> Arc<Self> {
        Arc::new(Self {
            spaces,
            debounce,
            pending: Mutex::new(HashMap::new()),
        })
    }

    async fn runtime(&self, key: &ResourceKey) -> Result<Arc<Embedded>> {
        self.spaces.get(key.space_id()).await
    }

    /// 取消并清掉一篇文档等待中的重新索引(文档被删除时)。
    pub fn cancel_reindex(&self, key: &str) {
        if let Some(handle) = self.pending.lock().unwrap().remove(key) {
            handle.abort();
        }
    }

    /// 落地之后过一会儿再重新索引;期间又有落地就重新计时。
    fn schedule_reindex(&self, doc_key: &str, key: ResourceKey) {
        let spaces = self.spaces.clone();
        let wait = self.debounce;
        let name = doc_key.to_owned();
        let handle = tokio::spawn(async move {
            tokio::time::sleep(wait).await;
            if let Err(err) = reindex(&spaces, &key).await {
                tracing::warn!(doc = %key, error = %err, "协作落地后重新索引失败");
            }
        });
        if let Some(previous) = self.pending.lock().unwrap().insert(name, handle) {
            previous.abort();
        }
    }
}

/// 重新嵌入 / 索引一篇文档。
async fn reindex(spaces: &SpaceRegistry, key: &ResourceKey) -> Result<()> {
    let runtime = spaces.get(key.space_id()).await?;
    match key {
        ResourceKey::Doc {
            name,
            doc: ShareDoc::Insight(id),
            ..
        } => {
            let _ = name;
            items(&runtime).reindex_insight(id).await?;
        }
        ResourceKey::Doc {
            name,
            doc: ShareDoc::File(path),
            ..
        } => {
            file_edits(&runtime).reindex_file(name, path).await?;
        }
        _ => {}
    }
    Ok(())
}

fn items(runtime: &Embedded) -> kb_service::ItemService {
    kb_service::ItemService::new(
        runtime.meta.clone(),
        runtime.store(),
        runtime.embedder.clone(),
    )
    .with_write_gate(runtime.write_gate())
    .with_skills(runtime.skills())
}

fn file_edits(runtime: &Embedded) -> kb_service::edit::FileEditService {
    let index = Arc::new(kb_service::IndexService::new(
        runtime.meta.clone(),
        runtime.store.clone(),
        runtime.embedder.clone(),
        runtime.chunker.clone(),
        runtime.scanner.clone(),
        kb_service::index::IndexOptions::default(),
    ));
    kb_service::edit::FileEditService::new(runtime.meta.clone(), index, runtime.paths.clone())
}

/// 版本历史里记的「谁」:这一段时间内的所有参与者(用户 id / 游客标识),逗号分隔。
fn authors(participants: &[Participant]) -> String {
    participants
        .iter()
        .map(|p| p.id.as_str())
        .collect::<Vec<_>>()
        .join(",")
}

fn parse(doc: &DocRef) -> Result<ResourceKey> {
    ResourceKey::parse(&doc.key)
}

#[async_trait]
impl CollabStore for CollabBackend {
    async fn load(&self, doc: &str) -> Result<Option<StoredDoc>> {
        let key = ResourceKey::parse(doc)?;
        let runtime = self.runtime(&key).await?;
        let Some(row) = runtime.meta.collab_load(doc).await? else {
            return Ok(None);
        };
        Ok(Some(StoredDoc {
            kind: DocKind::parse(&row.kind),
            snapshot: row.snapshot,
            updates: row.updates,
            materialized_sv: row.materialized_sv,
            landed_hash: row.landed_hash,
        }))
    }

    async fn append(
        &self,
        doc: &str,
        kind: DocKind,
        update: &[u8],
        user: &str,
        at: Millis,
    ) -> Result<()> {
        let key = ResourceKey::parse(doc)?;
        let runtime = self.runtime(&key).await?;
        runtime
            .meta
            .collab_append(doc, kind.as_str(), update, user, at)
            .await
    }

    async fn compact(&self, doc: &str, kind: DocKind, snapshot: &[u8], at: Millis) -> Result<()> {
        let key = ResourceKey::parse(doc)?;
        let runtime = self.runtime(&key).await?;
        runtime
            .meta
            .collab_compact(doc, kind.as_str(), snapshot, at)
            .await
    }

    async fn set_landed(&self, doc: &str, sv: &[u8], hash: &str, at: Millis) -> Result<()> {
        let key = ResourceKey::parse(doc)?;
        let runtime = self.runtime(&key).await?;
        runtime.meta.collab_set_landed(doc, sv, hash, at).await
    }

    async fn reset(&self, doc: &str) -> Result<()> {
        let key = ResourceKey::parse(doc)?;
        let runtime = self.runtime(&key).await?;
        runtime.meta.collab_reset(doc).await?;
        Ok(())
    }
}

#[async_trait]
impl CollabHooks for CollabBackend {
    async fn exists(&self, doc: &DocRef) -> bool {
        let Ok(key) = parse(doc) else {
            return false;
        };
        let Ok(runtime) = self.runtime(&key).await else {
            return false;
        };
        match &key {
            ResourceKey::Doc {
                doc: ShareDoc::Insight(id),
                ..
            } => items(&runtime).insight_body(id).await.is_ok(),
            ResourceKey::Doc {
                name,
                doc: ShareDoc::File(path),
                ..
            } => file_edits(&runtime).read_text(name, path).await.is_ok(),
            _ => false,
        }
    }

    async fn load_body(&self, doc: &DocRef) -> Result<Body> {
        let key = parse(doc)?;
        let runtime = self.runtime(&key).await?;
        match &key {
            ResourceKey::Doc {
                doc: ShareDoc::Insight(id),
                ..
            } => {
                let service = items(&runtime);
                let text = service.insight_body(id).await?;
                service.insight_baseline(id, "baseline").await?;
                Ok(Body { text })
            }
            ResourceKey::Doc {
                name,
                doc: ShareDoc::File(path),
                ..
            } => {
                let service = file_edits(&runtime);
                let text = service.read_text(name, path).await?;
                service.baseline(name, path).await?;
                Ok(Body { text })
            }
            _ => Err(KbError::InvalidInput("这种资源不能协作编辑".to_owned())),
        }
    }

    async fn land(&self, doc: &DocRef, landing: Landing) -> Result<String> {
        let key = parse(doc)?;
        let runtime = self.runtime(&key).await?;
        let (written, hash) = match &key {
            ResourceKey::Doc {
                doc: ShareDoc::Insight(id),
                ..
            } => items(&runtime).land_insight(id, &landing.text).await?,
            ResourceKey::Doc {
                name,
                doc: ShareDoc::File(path),
                ..
            } => file_edits(&runtime).land(name, path, &landing.text).await?,
            _ => return Err(KbError::InvalidInput("这种资源不能协作编辑".to_owned())),
        };
        if written {
            self.schedule_reindex(&doc.key, key);
        }
        Ok(hash)
    }

    async fn savepoint(&self, doc: &DocRef, participants: Vec<Participant>) -> Result<()> {
        let key = parse(doc)?;
        let runtime = self.runtime(&key).await?;
        let author = authors(&participants);
        let recorded = match &key {
            ResourceKey::Doc {
                doc: ShareDoc::Insight(id),
                ..
            } => items(&runtime).insight_savepoint(id, &author).await?,
            ResourceKey::Doc {
                name,
                doc: ShareDoc::File(path),
                ..
            } => file_edits(&runtime).savepoint(name, path, &author).await?,
            _ => false,
        };
        // 保存点是一段编辑的收尾:不用再等去抖,马上重新索引
        if recorded {
            self.cancel_reindex(&doc.key);
            if let Err(err) = reindex(&self.spaces, &key).await {
                tracing::warn!(doc = %doc.key, error = %err, "保存点后重新索引失败");
            }
        }
        Ok(())
    }

    fn hash(&self, text: &str) -> String {
        kb_core::hash::content_hash(text)
    }
}
