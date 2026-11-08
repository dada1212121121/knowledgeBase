//! `drafts` 表:草稿永远不进 LanceDB(设计规范坑 13)。

use async_trait::async_trait;
use kb_core::Result;
use kb_core::model::{Draft, DraftState, Page};
use kb_core::ports::repo::DraftRepo;
use rusqlite::{OptionalExtension, params};

use crate::SqliteMetaStore;
use crate::sql::{
    json_to_vec, map_sqlite_error, parse_draft_state, parse_insight_kind, vec_to_json,
};

const SELECT_COLUMNS: &str = "id, collection, title, body_md, kind, tags_json, evidence_json, \
     extractor_id, event_id, state, review_json, insight_id, created_at, decided_at, \
     fingerprint, embedding, embedder_id, related_paths_json";

struct RawDraft {
    id: String,
    collection: String,
    title: String,
    body_md: String,
    kind: String,
    tags_json: String,
    evidence_json: String,
    extractor_id: String,
    event_id: Option<String>,
    state: String,
    review_json: Option<String>,
    insight_id: Option<String>,
    created_at: i64,
    decided_at: Option<i64>,
    fingerprint: String,
    embedding: Option<Vec<u8>>,
    embedder_id: Option<String>,
    related_paths_json: String,
}

fn raw_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawDraft> {
    Ok(RawDraft {
        id: row.get(0)?,
        collection: row.get(1)?,
        title: row.get(2)?,
        body_md: row.get(3)?,
        kind: row.get(4)?,
        tags_json: row.get(5)?,
        evidence_json: row.get(6)?,
        extractor_id: row.get(7)?,
        event_id: row.get(8)?,
        state: row.get(9)?,
        review_json: row.get(10)?,
        insight_id: row.get(11)?,
        created_at: row.get(12)?,
        decided_at: row.get(13)?,
        fingerprint: row.get(14)?,
        embedding: row.get(15)?,
        embedder_id: row.get(16)?,
        related_paths_json: row.get(17)?,
    })
}

impl RawDraft {
    fn into_draft(self) -> Result<Draft> {
        Ok(Draft {
            kind: parse_insight_kind(&self.kind)?,
            state: parse_draft_state(&self.state)?,
            tags: json_to_vec(&self.tags_json)?,
            related_paths: json_to_vec(&self.related_paths_json)?,
            id: self.id,
            collection: self.collection,
            title: self.title,
            body_md: self.body_md,
            evidence_json: self.evidence_json,
            extractor_id: self.extractor_id,
            event_id: self.event_id,
            review_json: self.review_json,
            insight_id: self.insight_id,
            fingerprint: self.fingerprint,
            embedding: self.embedding.as_deref().map(decode_vector),
            embedder_id: self.embedder_id,
            created_at: self.created_at,
            decided_at: self.decided_at,
        })
    }
}

/// 状态字符串(供其它 repo 复用)。
pub(crate) fn draft_state_text(state: DraftState) -> &'static str {
    state_text(state)
}

fn state_text(state: DraftState) -> &'static str {
    match state {
        DraftState::Pending => "pending",
        DraftState::Approved => "approved",
        DraftState::Revised => "revised",
        DraftState::Rejected => "rejected",
        DraftState::Duplicate => "duplicate",
    }
}

#[async_trait]
impl DraftRepo for SqliteMetaStore {
    async fn create(&self, draft: Draft) -> Result<()> {
        let state = state_text(draft.state);
        self.write(move |conn| {
            conn.execute(
                "INSERT INTO drafts (id, collection, title, body_md, kind, tags_json, evidence_json, \
                 extractor_id, event_id, state, review_json, insight_id, created_at, decided_at, \
                 fingerprint, embedding, embedder_id, related_paths_json) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
                params![
                    draft.id,
                    draft.collection,
                    draft.title,
                    draft.body_md,
                    draft.kind.as_str(),
                    vec_to_json(&draft.tags),
                    draft.evidence_json,
                    draft.extractor_id,
                    draft.event_id,
                    state,
                    draft.review_json,
                    draft.insight_id,
                    draft.created_at,
                    draft.decided_at,
                    draft.fingerprint,
                    draft.embedding.as_deref().map(encode_vector),
                    draft.embedder_id,
                    vec_to_json(&draft.related_paths),
                ],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn get(&self, id: &str) -> Result<Option<Draft>> {
        let id = id.to_owned();
        self.read(move |conn| {
            let raw = conn
                .query_row(
                    &format!("SELECT {SELECT_COLUMNS} FROM drafts WHERE id = ?1"),
                    params![id],
                    raw_from_row,
                )
                .optional()
                .map_err(map_sqlite_error)?;
            raw.map(RawDraft::into_draft).transpose()
        })
        .await
    }

    async fn list(&self, state: Option<DraftState>, page: Page) -> Result<Vec<Draft>> {
        self.read(move |conn| {
            let sql = match state {
                Some(_) => format!(
                    "SELECT {SELECT_COLUMNS} FROM drafts WHERE state = ?1 \
                     ORDER BY created_at DESC, id LIMIT ?2 OFFSET ?3"
                ),
                None => format!(
                    "SELECT {SELECT_COLUMNS} FROM drafts ORDER BY created_at DESC, id LIMIT ?1 OFFSET ?2"
                ),
            };
            let mut stmt = conn.prepare(&sql).map_err(map_sqlite_error)?;
            let rows = match state {
                Some(state) => stmt
                    .query_map(
                        params![state_text(state), i64::from(page.limit), i64::from(page.offset)],
                        raw_from_row,
                    )
                    .map_err(map_sqlite_error)?
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(map_sqlite_error)?,
                None => stmt
                    .query_map(
                        params![i64::from(page.limit), i64::from(page.offset)],
                        raw_from_row,
                    )
                    .map_err(map_sqlite_error)?
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(map_sqlite_error)?,
            };
            rows.into_iter().map(RawDraft::into_draft).collect()
        })
        .await
    }

    async fn list_states(&self, states: &[DraftState], page: Page) -> Result<Vec<Draft>> {
        let states: Vec<&'static str> = states.iter().copied().map(state_text).collect();
        self.read(move |conn| {
            if states.is_empty() {
                return Ok(Vec::new());
            }
            let placeholders = placeholders(states.len());
            let sql = format!(
                "SELECT {SELECT_COLUMNS} FROM drafts WHERE state IN ({placeholders}) \
                 ORDER BY created_at DESC, id LIMIT ?{} OFFSET ?{}",
                states.len() + 1,
                states.len() + 2
            );
            let mut params: Vec<Box<dyn rusqlite::ToSql>> = states
                .iter()
                .map(|state| Box::new((*state).to_owned()) as Box<dyn rusqlite::ToSql>)
                .collect();
            params.push(Box::new(i64::from(page.limit)));
            params.push(Box::new(i64::from(page.offset)));
            let refs: Vec<&dyn rusqlite::ToSql> =
                params.iter().map(|value| value.as_ref()).collect();
            let mut stmt = conn.prepare(&sql).map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map(refs.as_slice(), raw_from_row)
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            rows.into_iter().map(RawDraft::into_draft).collect()
        })
        .await
    }

    async fn count_states(&self, states: &[DraftState]) -> Result<u64> {
        let states: Vec<&'static str> = states.iter().copied().map(state_text).collect();
        self.read(move |conn| {
            if states.is_empty() {
                return Ok(0);
            }
            let placeholders = placeholders(states.len());
            let sql = format!("SELECT COUNT(*) FROM drafts WHERE state IN ({placeholders})");
            let refs: Vec<&dyn rusqlite::ToSql> = states
                .iter()
                .map(|state| state as &dyn rusqlite::ToSql)
                .collect();
            let total: i64 = conn
                .query_row(&sql, refs.as_slice(), |row| row.get(0))
                .map_err(map_sqlite_error)?;
            Ok(total.max(0) as u64)
        })
        .await
    }

    async fn claim(&self, id: &str, at: i64, ttl: i64) -> Result<bool> {
        let id = id.to_owned();
        self.write(move |conn| {
            // 条件全部放在 SQL 里:没抢过(或抢占已过期)、没转正、状态还在“可以转正”的那几种
            let changed = conn
                .execute(
                    "UPDATE drafts SET claimed_at = ?1 \
                      WHERE id = ?2 AND insight_id IS NULL \
                        AND (claimed_at IS NULL OR claimed_at < ?1 - ?3) \
                        AND state IN ('pending', 'duplicate', 'approved', 'revised')",
                    params![at, id, ttl.max(0)],
                )
                .map_err(map_sqlite_error)?;
            Ok(changed == 1)
        })
        .await
    }

    async fn release_claim(&self, id: &str, at: i64) -> Result<()> {
        let id = id.to_owned();
        self.write(move |conn| {
            // 只释放自己抢到的那一次(质量检查 :慢请求不能把别人接管的抢占清掉)
            conn.execute(
                "UPDATE drafts SET claimed_at = NULL WHERE id = ?1 AND claimed_at = ?2",
                params![id, at],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn clear_stale_claims(&self, now: i64, ttl: i64) -> Result<u64> {
        self.write(move |conn| {
            let changed = conn
                .execute(
                    "UPDATE drafts SET claimed_at = NULL \
                      WHERE claimed_at IS NOT NULL AND (insight_id IS NOT NULL OR claimed_at < ?1 - ?2)",
                    params![now, ttl.max(0)],
                )
                .map_err(map_sqlite_error)?;
            Ok(changed as u64)
        })
        .await
    }

    async fn count(&self, state: Option<DraftState>) -> Result<u64> {
        self.read(move |conn| {
            let total: i64 = match state {
                Some(state) => conn.query_row(
                    "SELECT COUNT(*) FROM drafts WHERE state = ?1",
                    params![state_text(state)],
                    |row| row.get(0),
                ),
                None => conn.query_row("SELECT COUNT(*) FROM drafts", [], |row| row.get(0)),
            }
            .map_err(map_sqlite_error)?;
            Ok(total.max(0) as u64)
        })
        .await
    }

    async fn update(&self, draft: Draft) -> Result<()> {
        let state = state_text(draft.state);
        self.write(move |conn| {
            conn.execute(
                "UPDATE drafts SET title = ?2, body_md = ?3, kind = ?4, tags_json = ?5, \
                 state = ?6, review_json = ?7, insight_id = ?8, decided_at = ?9, \
                 fingerprint = ?10, embedding = ?11, embedder_id = ?12, \
                 related_paths_json = ?13, evidence_json = ?14 WHERE id = ?1",
                params![
                    draft.id,
                    draft.title,
                    draft.body_md,
                    draft.kind.as_str(),
                    vec_to_json(&draft.tags),
                    state,
                    draft.review_json,
                    draft.insight_id,
                    draft.decided_at,
                    draft.fingerprint,
                    draft.embedding.as_deref().map(encode_vector),
                    draft.embedder_id,
                    vec_to_json(&draft.related_paths),
                    draft.evidence_json,
                ],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }
}

/// 生成 `?1, ?2, …` 这样的占位符列表(数量来自代码,不是外部输入)。
fn placeholders(count: usize) -> String {
    (1..=count)
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// 向量 → BLOB(f32 小端,与 `insights.embedding` 的存法一致)。
fn encode_vector(vector: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(vector.len() * 4);
    for value in vector {
        out.extend_from_slice(&value.to_le_bytes());
    }
    out
}

/// BLOB → 向量。
fn decode_vector(bytes: &[u8]) -> Vec<f32> {
    bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|chunk| f32::from_le_bytes(*chunk))
        .collect()
}
