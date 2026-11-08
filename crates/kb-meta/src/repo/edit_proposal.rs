//! AI 的修改建议(`edit_proposals`）。这里只管存取;定位和应用在守护进程里。

use kb_core::Result;
use kb_core::model::Millis;
use rusqlite::{OptionalExtension, params};
use serde::Serialize;

use crate::SqliteMetaStore;
use crate::sql::map_sqlite_error;

/// 一条修改建议。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct EditProposal {
    /// id。
    pub id: String,
    /// collection 名。
    pub collection: String,
    /// `file:<相对路径>` / `note:<笔记 id>`。
    pub target: String,
    /// 谁提的。
    pub author: String,
    /// 说明。
    pub note: String,
    /// `[{"old": …, "new": …}]`。
    pub edits: serde_json::Value,
    /// pending / accepted / rejected / failed。
    pub status: String,
    /// 失败的原因。
    pub result: Option<String>,
    /// 提出时间。
    pub created_at: Millis,
    /// 处理时间。
    pub decided_at: Option<Millis>,
    /// 谁处理的。
    pub decided_by: Option<String>,
}

const COLUMNS: &str = "id, collection, target, author, note, edits, status, result, created_at, decided_at, decided_by";

fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<EditProposal> {
    let edits: String = row.get(5)?;
    Ok(EditProposal {
        id: row.get(0)?,
        collection: row.get(1)?,
        target: row.get(2)?,
        author: row.get(3)?,
        note: row.get(4)?,
        edits: serde_json::from_str(&edits).unwrap_or(serde_json::Value::Null),
        status: row.get(6)?,
        result: row.get(7)?,
        created_at: row.get(8)?,
        decided_at: row.get(9)?,
        decided_by: row.get(10)?,
    })
}

impl SqliteMetaStore {
    /// 记一条新建议(状态 pending)。
    pub async fn proposal_create(&self, proposal: EditProposal) -> Result<()> {
        self.write(move |conn| {
            conn.execute(
                &format!("INSERT INTO edit_proposals ({COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)"),
                params![
                    proposal.id,
                    proposal.collection,
                    proposal.target,
                    proposal.author,
                    proposal.note,
                    proposal.edits.to_string(),
                    proposal.status,
                    proposal.result,
                    proposal.created_at,
                    proposal.decided_at,
                    proposal.decided_by,
                ],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    /// 取一条。
    pub async fn proposal_get(&self, id: &str) -> Result<Option<EditProposal>> {
        let id = id.to_owned();
        self.read(move |conn| {
            conn.query_row(
                &format!("SELECT {COLUMNS} FROM edit_proposals WHERE id = ?1"),
                params![id],
                row,
            )
            .optional()
            .map_err(map_sqlite_error)
        })
        .await
    }

    /// 某个文档的建议(新 → 旧);`status` 为空时全部,最多 `limit` 条。
    pub async fn proposal_list(
        &self,
        collection: &str,
        target: &str,
        status: Option<&str>,
        limit: u32,
    ) -> Result<Vec<EditProposal>> {
        let (collection, target, status) = (
            collection.to_owned(),
            target.to_owned(),
            status.map(str::to_owned),
        );
        self.read(move |conn| {
            let mut statement = conn
                .prepare(&format!(
                    "SELECT {COLUMNS} FROM edit_proposals WHERE collection = ?1 AND target = ?2 \
                     AND (?3 IS NULL OR status = ?3) ORDER BY created_at DESC, id DESC LIMIT ?4"
                ))
                .map_err(map_sqlite_error)?;
            let rows = statement
                .query_map(params![collection, target, status, limit], row)
                .map_err(map_sqlite_error)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)
        })
        .await
    }

    /// 处理一条还在等待的建议。已经处理过的不再改(返回 false):两个人同时点「接受」只生效一次。
    pub async fn proposal_decide(
        &self,
        id: &str,
        status: &str,
        by: &str,
        result: Option<&str>,
        at: Millis,
    ) -> Result<bool> {
        let (id, status, by, result) = (
            id.to_owned(),
            status.to_owned(),
            by.to_owned(),
            result.map(str::to_owned),
        );
        self.write(move |conn| {
            let changed = conn
                .execute(
                    "UPDATE edit_proposals SET status = ?2, decided_by = ?3, result = ?4, decided_at = ?5 \
                     WHERE id = ?1 AND status = 'pending'",
                    params![id, status, by, result, at],
                )
                .map_err(map_sqlite_error)?;
            Ok(changed == 1)
        })
        .await
    }

    /// 接受之后应用失败:把已经认领的建议改成失败并记下原因(不管现在是什么状态)。
    pub async fn proposal_fail(&self, id: &str, reason: &str) -> Result<()> {
        let (id, reason) = (id.to_owned(), reason.to_owned());
        self.write(move |conn| {
            conn.execute(
                "UPDATE edit_proposals SET status = 'failed', result = ?2 WHERE id = ?1",
                params![id, reason],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }
}
