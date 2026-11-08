//! **进程级**写闸门(设计规范第 6 步“短暂暂停该 collection 的写任务”)。
//!
//! 注意范围:这是**一把进程级单锁**,不是按 collection 分片的锁 —— 任何一个 collection 的迁移收尾,
//! 都会让**所有**项目的索引写入排队(迁移很罕见,换来的是实现简单、不会漏接;按 collection 分片
//! 是 建议的另一种做法,若以后迁移变频繁再改)。锁内耗时会在迁移结束时打一行 `info`。
//!
//! 换模型迁移的最后一段(最后一次追平 → 条数校验 → 切换 → 切换后对账)必须与索引写入互斥,
//! 否则索引任务会拿着切换前的 collection 快照把块写进/删出退役表,新表里就会残留
//! 已被删除块的向量(搜索仍会命中已删除文件的内容)。 选择根治而不是登记偏差:
//!
//! - 索引写路径(项目索引 / 全局导入 / 索引任务分片)先拿**读锁**,拿到之后再读 collection,
//!   因此要么在切换前完成(迁移的追平与对账会看到它的结果),要么在切换后开始(读到新 active 表);
//! - 迁移在收尾那一段拿**写锁**,等在途写入结束并阻塞新的写入。
//!
//! 同一进程内共享一个实例(组装根 `kb-cli` 的 `Embedded` 持有),跨进程由 `run/daemon.lock` 保证。

use std::sync::Arc;

use tokio::sync::{OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};

/// collection 写闸门(可克隆,克隆之间共享同一把锁)。
#[derive(Clone, Default)]
pub struct WriteGate {
    inner: Arc<RwLock<()>>,
}

impl WriteGate {
    /// 新建一把独立的闸门。
    pub fn new() -> Self {
        Self::default()
    }

    /// 索引写路径:拿读锁(多个索引任务可以并发)。
    pub async fn writer(&self) -> OwnedRwLockReadGuard<()> {
        self.inner.clone().read_owned().await
    }

    /// 迁移收尾:拿写锁(等待在途写入结束,并阻塞新的写入)。
    pub async fn migration(&self) -> OwnedRwLockWriteGuard<()> {
        self.inner.clone().write_owned().await
    }

    /// 要独占但**不能等**的维护活(孤儿向量对账):现在没有任何写入在途才拿得到,拿不到返回 `None`,
    /// 调用方这一轮跳过、下一轮再试。不用排队的写锁,是因为 tokio 的写锁一排队就会挡住后来的读者:
    /// 一次长分片还在跑时去排队,保存笔记这类交互写入都会跟着卡住。
    pub fn try_exclusive(&self) -> Option<OwnedRwLockWriteGuard<()>> {
        self.inner.clone().try_write_owned().ok()
    }
}

impl std::fmt::Debug for WriteGate {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("WriteGate").finish_non_exhaustive()
    }
}

/// 拿读锁,**拿到之后再**读 collection 的 `active_table`。
///
/// 这是所有 LanceDB 写路径必须遵守的次序(先锁后读,见模块注释):迁移可能在两者之间
/// 切换了 active 表,先读后锁就会把行写进刚退役的表。返回的 guard 要一直持有到写操作结束。
///
/// 只在**最外层**调用一次:tokio 的 `RwLock` 是写优先的,持读锁再拿读锁会在有迁移排队时
/// 自锁(`revert` / `items` 内部的写函数因此都不自己拿锁)。
pub async fn lock_and_table(
    gate: &WriteGate,
    meta: &dyn kb_core::ports::repo::MetaStore,
    collection: &str,
) -> kb_core::Result<(OwnedRwLockReadGuard<()>, String)> {
    let guard = gate.writer().await;
    let table = kb_core::ports::repo::CollectionRepo::get(meta, collection)
        .await?
        .ok_or_else(|| kb_core::KbError::NotFound(format!("collection {collection}")))?
        .active_table;
    Ok((guard, table))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn in_flight_writers_block_the_migration() {
        let gate = WriteGate::new();
        let writer = gate.writer().await;
        assert!(
            gate.inner.try_write().is_err(),
            "有在途写入(读锁)时迁移不应拿到写锁"
        );
        drop(writer);
        assert!(
            gate.inner.try_write().is_ok(),
            "在途写入结束后迁移应能拿到写锁"
        );
    }

    #[tokio::test]
    async fn the_migration_blocks_new_writers() {
        let gate = WriteGate::new();
        let migration = gate.migration().await;
        assert!(
            gate.inner.try_read().is_err(),
            "迁移持写锁时新的写入不应拿到读锁"
        );
        drop(migration);
        assert!(gate.inner.try_read().is_ok(), "迁移结束后写入应能拿到读锁");
    }
}
