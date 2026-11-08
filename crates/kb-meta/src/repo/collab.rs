//! 协作状态(`collab_state` / `collab_updates`）。
//!
//! 一篇文档 = 一份快照 + 快照之后按 `seq` 排序的增量更新。这里只管存取,不认识 Yjs 的内容。

use kb_core::Result;
use kb_core::model::Millis;
use rusqlite::{OptionalExtension, params};

use crate::SqliteMetaStore;
use crate::sql::map_sqlite_error;

/// 库里的一篇协作文档。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CollabRow {
    /// `text` / `prosemirror`。
    pub kind: String,
    /// 快照(可能为空)。
    pub snapshot: Vec<u8>,
    /// 快照之后的增量。
    pub updates: Vec<Vec<u8>>,
    /// 最近一次落地时的状态向量。
    pub materialized_sv: Option<Vec<u8>>,
    /// 最近一次落地的正文哈希。
    pub landed_hash: Option<String>,
}

impl SqliteMetaStore {
    /// 读一篇协作文档;没有任何记录返回 `None`。
    pub async fn collab_load(&self, doc: &str) -> Result<Option<CollabRow>> {
        let doc = doc.to_owned();
        self.read(move |conn| {
            let state = conn
                .query_row(
                    "SELECT kind, snapshot, materialized_sv, landed_hash FROM collab_state WHERE doc_id = ?1",
                    params![doc],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, Vec<u8>>(1)?,
                            row.get::<_, Option<Vec<u8>>>(2)?,
                            row.get::<_, Option<String>>(3)?,
                        ))
                    },
                )
                .optional()
                .map_err(map_sqlite_error)?;
            let Some((kind, snapshot, materialized_sv, landed_hash)) = state else {
                return Ok(None);
            };
            let mut statement = conn
                .prepare("SELECT update_blob FROM collab_updates WHERE doc_id = ?1 ORDER BY seq")
                .map_err(map_sqlite_error)?;
            let updates = statement
                .query_map(params![doc], |row| row.get::<_, Vec<u8>>(0))
                .map_err(map_sqlite_error)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(map_sqlite_error)?;
            Ok(Some(CollabRow {
                kind,
                snapshot,
                updates,
                materialized_sv,
                landed_hash,
            }))
        })
        .await
    }

    /// 追加一条增量更新(顺序由 `seq` 保证)。
    pub async fn collab_append(
        &self,
        doc: &str,
        kind: &str,
        update: &[u8],
        user: &str,
        at: Millis,
    ) -> Result<()> {
        let (doc, kind, update, user) = (
            doc.to_owned(),
            kind.to_owned(),
            update.to_vec(),
            user.to_owned(),
        );
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            tx.execute(
                "INSERT INTO collab_state (doc_id, kind, updated_at) VALUES (?1, ?2, ?3) \
                 ON CONFLICT(doc_id) DO UPDATE SET kind = excluded.kind, updated_at = excluded.updated_at",
                params![doc, kind, at],
            )
            .map_err(map_sqlite_error)?;
            let next: i64 = tx
                .query_row(
                    "SELECT COALESCE(MAX(seq), 0) + 1 FROM collab_updates WHERE doc_id = ?1",
                    params![doc],
                    |row| row.get(0),
                )
                .map_err(map_sqlite_error)?;
            tx.execute(
                "INSERT INTO collab_updates (doc_id, seq, update_blob, user_id, at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![doc, next, update, user, at],
            )
            .map_err(map_sqlite_error)?;
            tx.commit().map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    /// 用新的完整状态替换快照,并清掉已并入的增量。
    pub async fn collab_compact(
        &self,
        doc: &str,
        kind: &str,
        snapshot: &[u8],
        at: Millis,
    ) -> Result<()> {
        let (doc, kind, snapshot) = (doc.to_owned(), kind.to_owned(), snapshot.to_vec());
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            tx.execute(
                "INSERT INTO collab_state (doc_id, kind, snapshot, updated_at) VALUES (?1, ?2, ?3, ?4) \
                 ON CONFLICT(doc_id) DO UPDATE SET kind = excluded.kind, snapshot = excluded.snapshot, \
                 updated_at = excluded.updated_at",
                params![doc, kind, snapshot, at],
            )
            .map_err(map_sqlite_error)?;
            tx.execute("DELETE FROM collab_updates WHERE doc_id = ?1", params![doc])
                .map_err(map_sqlite_error)?;
            tx.commit().map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    /// 记下一次落地。
    pub async fn collab_set_landed(
        &self,
        doc: &str,
        sv: &[u8],
        hash: &str,
        at: Millis,
    ) -> Result<()> {
        let (doc, sv, hash) = (doc.to_owned(), sv.to_vec(), hash.to_owned());
        self.write(move |conn| {
            // 还没有状态行时先建一行(kind 暂用 text,下一次 append / compact 会写成真实的结构)
            conn.execute(
                "INSERT INTO collab_state (doc_id, kind, materialized_sv, landed_hash, materialized_at, updated_at) \
                 VALUES (?1, 'text', ?2, ?3, ?4, ?4) \
                 ON CONFLICT(doc_id) DO UPDATE SET materialized_sv = excluded.materialized_sv, \
                 landed_hash = excluded.landed_hash, materialized_at = excluded.materialized_at",
                params![doc, sv, hash, at],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    /// 丢掉一篇文档的全部协作状态。返回有没有东西被删。
    pub async fn collab_reset(&self, doc: &str) -> Result<bool> {
        let doc = doc.to_owned();
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            tx.execute("DELETE FROM collab_updates WHERE doc_id = ?1", params![doc])
                .map_err(map_sqlite_error)?;
            let removed = tx
                .execute("DELETE FROM collab_state WHERE doc_id = ?1", params![doc])
                .map_err(map_sqlite_error)?;
            tx.commit().map_err(map_sqlite_error)?;
            Ok(removed > 0)
        })
        .await
    }

    /// 丢掉某个键及它下面所有文档的协作状态(删除集合 / 目录时)。`prefixes` 是已经算好的、
    /// 要删的文档键;调用方按资源键的结构判断「在不在它底下」,这里不拿字符串前缀猜。
    pub async fn collab_reset_many(&self, docs: &[String]) -> Result<usize> {
        let mut removed = 0;
        for doc in docs {
            if self.collab_reset(doc).await? {
                removed += 1;
            }
        }
        Ok(removed)
    }

    /// 所有有协作状态的文档键(用来在删除资源时按结构筛选)。
    pub async fn collab_docs(&self) -> Result<Vec<String>> {
        self.read(|conn| {
            let mut statement = conn
                .prepare("SELECT doc_id FROM collab_state ORDER BY doc_id")
                .map_err(map_sqlite_error)?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(map_sqlite_error)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(map_sqlite_error)?;
            Ok(rows)
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn store() -> (tempfile::TempDir, SqliteMetaStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = SqliteMetaStore::open(dir.path().join("meta.db")).unwrap();
        (dir, store)
    }

    #[tokio::test]
    async fn updates_come_back_in_the_order_they_were_appended() {
        let (_dir, store) = store().await;
        assert_eq!(store.collab_load("k").await.unwrap(), None);
        for i in 0..5u8 {
            store
                .collab_append("k", "text", &[i, i], "usr_a", 1000 + i64::from(i))
                .await
                .unwrap();
        }
        let row = store.collab_load("k").await.unwrap().unwrap();
        assert_eq!(row.kind, "text");
        assert_eq!(
            row.updates,
            (0..5u8).map(|i| vec![i, i]).collect::<Vec<_>>()
        );
        assert!(row.snapshot.is_empty());
        // 另一篇文档互不影响
        store
            .collab_append("other", "prosemirror", &[9], "usr_b", 1)
            .await
            .unwrap();
        assert_eq!(
            store.collab_load("k").await.unwrap().unwrap().updates.len(),
            5
        );
        assert_eq!(
            store.collab_load("other").await.unwrap().unwrap().kind,
            "prosemirror"
        );
    }

    #[tokio::test]
    async fn compaction_replaces_the_snapshot_and_clears_the_increments_atomically() {
        let (_dir, store) = store().await;
        store
            .collab_append("k", "text", &[1], "u", 1)
            .await
            .unwrap();
        store
            .collab_append("k", "text", &[2], "u", 2)
            .await
            .unwrap();
        store
            .collab_compact("k", "text", &[7, 7, 7], 3)
            .await
            .unwrap();
        let row = store.collab_load("k").await.unwrap().unwrap();
        assert_eq!(row.snapshot, vec![7, 7, 7]);
        assert!(row.updates.is_empty());
        // 合并之后继续追加,顺序仍然正确
        store
            .collab_append("k", "text", &[8], "u", 4)
            .await
            .unwrap();
        store
            .collab_append("k", "text", &[9], "u", 5)
            .await
            .unwrap();
        assert_eq!(
            store.collab_load("k").await.unwrap().unwrap().updates,
            vec![vec![8], vec![9]]
        );
    }

    #[tokio::test]
    async fn landing_info_survives_later_writes_and_reset_forgets_everything() {
        let (_dir, store) = store().await;
        store
            .collab_append("k", "prosemirror", &[1], "u", 1)
            .await
            .unwrap();
        store
            .collab_set_landed("k", &[4, 5], "hash-1", 2)
            .await
            .unwrap();
        store
            .collab_append("k", "prosemirror", &[2], "u", 3)
            .await
            .unwrap();
        store
            .collab_compact("k", "prosemirror", &[3], 4)
            .await
            .unwrap();
        let row = store.collab_load("k").await.unwrap().unwrap();
        assert_eq!(row.materialized_sv, Some(vec![4, 5]));
        assert_eq!(row.landed_hash.as_deref(), Some("hash-1"));
        assert_eq!(row.kind, "prosemirror", "落地信息不会把结构改回去");
        // 只落地过、还没有任何更新也能读到
        store
            .collab_set_landed("fresh", &[1], "h", 5)
            .await
            .unwrap();
        assert_eq!(
            store
                .collab_load("fresh")
                .await
                .unwrap()
                .unwrap()
                .landed_hash
                .as_deref(),
            Some("h")
        );
        assert_eq!(
            store.collab_docs().await.unwrap(),
            vec!["fresh".to_owned(), "k".to_owned()]
        );
        assert!(store.collab_reset("k").await.unwrap());
        assert_eq!(store.collab_load("k").await.unwrap(), None);
        assert!(!store.collab_reset("k").await.unwrap(), "已经没有了");
        assert_eq!(
            store
                .collab_reset_many(&["fresh".to_owned(), "none".to_owned()])
                .await
                .unwrap(),
            1
        );
    }

    #[tokio::test]
    async fn large_blobs_round_trip() {
        let (_dir, store) = store().await;
        let big: Vec<u8> = (0..3_000_000u32).map(|i| (i % 251) as u8).collect();
        store.collab_compact("k", "text", &big, 1).await.unwrap();
        assert_eq!(store.collab_load("k").await.unwrap().unwrap().snapshot, big);
    }
}
