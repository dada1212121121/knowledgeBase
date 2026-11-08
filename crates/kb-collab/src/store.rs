//! 协作状态的持久化接口。
//!
//! 一篇文档在库里是「一份快照 + 快照之后的若干增量更新」:每次刷盘追加一条增量,
//! 增量多了就合并进快照。加载 = 快照 + 全部增量重放。

use std::collections::HashMap;
use std::sync::Mutex;

use async_trait::async_trait;
use kb_core::Result;
use kb_core::model::Millis;

use crate::types::DocKind;

/// 库里的一篇文档。
#[derive(Clone, Debug, Default)]
pub struct StoredDoc {
    /// 结构。
    pub kind: Option<DocKind>,
    /// 快照(Yjs 完整状态,v1 编码)。空 = 还没有快照。
    pub snapshot: Vec<u8>,
    /// 快照之后的增量更新(按写入顺序)。
    pub updates: Vec<Vec<u8>>,
    /// 最近一次**落地**到正文时,客户端提交的状态向量。
    pub materialized_sv: Option<Vec<u8>>,
    /// 最近一次落地的正文内容哈希。再打开时用它判断正文有没有被别的途径(API)改过。
    pub landed_hash: Option<String>,
}

/// 持久化接口。守护进程按知识库分库,用 SQLite 实现;测试用 [`MemoryStore`]。
#[async_trait]
pub trait CollabStore: Send + Sync {
    /// 读一篇文档;没有就 `None`。
    async fn load(&self, doc: &str) -> Result<Option<StoredDoc>>;
    /// 追加一条增量更新。`user` 是产生它的人(用来在管理后台排查)。
    async fn append(
        &self,
        doc: &str,
        kind: DocKind,
        update: &[u8],
        user: &str,
        at: Millis,
    ) -> Result<()>;
    /// 用新的完整状态替换快照,并清掉已经并进去的增量。
    async fn compact(&self, doc: &str, kind: DocKind, snapshot: &[u8], at: Millis) -> Result<()>;
    /// 记下这次落地:客户端提交的状态向量和落地的正文哈希。
    async fn set_landed(&self, doc: &str, sv: &[u8], hash: &str, at: Millis) -> Result<()>;
    /// 丢掉一篇文档的全部协作状态(正文被别的途径改过、需要重新初始化时)。
    async fn reset(&self, doc: &str) -> Result<()>;
}

/// 内存实现:测试用,也能当不落盘的后备。
#[derive(Default)]
pub struct MemoryStore {
    docs: Mutex<HashMap<String, StoredDoc>>,
}

impl MemoryStore {
    /// 新建。
    pub fn new() -> Self {
        Self::default()
    }

    /// 取一份拷贝,测试里看内部状态。
    pub fn peek(&self, doc: &str) -> Option<StoredDoc> {
        self.docs.lock().unwrap().get(doc).cloned()
    }
}

#[async_trait]
impl CollabStore for MemoryStore {
    async fn load(&self, doc: &str) -> Result<Option<StoredDoc>> {
        Ok(self.docs.lock().unwrap().get(doc).cloned())
    }

    async fn append(
        &self,
        doc: &str,
        kind: DocKind,
        update: &[u8],
        _user: &str,
        _at: Millis,
    ) -> Result<()> {
        let mut docs = self.docs.lock().unwrap();
        let entry = docs.entry(doc.to_owned()).or_default();
        entry.kind = Some(kind);
        entry.updates.push(update.to_vec());
        Ok(())
    }

    async fn compact(&self, doc: &str, kind: DocKind, snapshot: &[u8], _at: Millis) -> Result<()> {
        let mut docs = self.docs.lock().unwrap();
        let entry = docs.entry(doc.to_owned()).or_default();
        entry.kind = Some(kind);
        entry.snapshot = snapshot.to_vec();
        entry.updates.clear();
        Ok(())
    }

    async fn set_landed(&self, doc: &str, sv: &[u8], hash: &str, _at: Millis) -> Result<()> {
        let mut docs = self.docs.lock().unwrap();
        let entry = docs.entry(doc.to_owned()).or_default();
        entry.materialized_sv = Some(sv.to_vec());
        entry.landed_hash = Some(hash.to_owned());
        Ok(())
    }

    async fn reset(&self, doc: &str) -> Result<()> {
        self.docs.lock().unwrap().remove(doc);
        Ok(())
    }
}
