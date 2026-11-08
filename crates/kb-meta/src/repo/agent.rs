//! `agent_messages` 表:AI 管家会话记录。

use async_trait::async_trait;
use kb_core::Result;
use kb_core::model::{AgentMessage, AgentSessionMeta, AgentSessionSummary, Millis};
use kb_core::ports::repo::AgentRepo;
use rusqlite::params;

use crate::SqliteMetaStore;
use crate::sql::map_sqlite_error;

#[async_trait]
impl AgentRepo for SqliteMetaStore {
    async fn append(&self, message: AgentMessage) -> Result<i64> {
        self.write(move |conn| {
            let next: i64 = conn
                .query_row(
                    "SELECT COALESCE(MAX(seq), 0) + 1 FROM agent_messages WHERE session_id = ?1",
                    params![message.session_id],
                    |row| row.get(0),
                )
                .map_err(map_sqlite_error)?;
            conn.execute(
                "INSERT INTO agent_messages (session_id, seq, role, content_json, at) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    message.session_id,
                    next,
                    message.role,
                    message.content_json,
                    message.at,
                ],
            )
            .map_err(map_sqlite_error)?;
            Ok(next)
        })
        .await
    }

    async fn list(&self, session_id: &str, limit: u32) -> Result<Vec<AgentMessage>> {
        let session_id = session_id.to_owned();
        self.read(move |conn| {
            let mut statement = conn
                .prepare(
                    "SELECT session_id, seq, role, content_json, at FROM agent_messages \
                     WHERE session_id = ?1 ORDER BY seq ASC LIMIT ?2",
                )
                .map_err(map_sqlite_error)?;
            let rows = statement
                .query_map(params![session_id, limit.max(1) as i64], |row| {
                    Ok(AgentMessage {
                        session_id: row.get(0)?,
                        seq: row.get(1)?,
                        role: row.get(2)?,
                        content_json: row.get(3)?,
                        at: row.get(4)?,
                    })
                })
                .map_err(map_sqlite_error)?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row.map_err(map_sqlite_error)?);
            }
            Ok(out)
        })
        .await
    }

    async fn sessions(
        &self,
        limit: u32,
        project: Option<&str>,
    ) -> Result<Vec<AgentSessionSummary>> {
        let project = project.unwrap_or_default().to_owned();
        self.read(move |conn| {
            let mut statement = conn
                .prepare(
                    "SELECT m.session_id, MIN(m.at), MAX(m.at), COUNT(*), \
                     COALESCE(s.title, ''), COALESCE(s.project, ''), COALESCE(s.pinned, 0), \
                     COALESCE(s.backend, 'builtin'), \
                     COALESCE((SELECT f.content_json FROM agent_messages f \
                               WHERE f.session_id = m.session_id AND f.role = 'user' \
                               ORDER BY f.seq ASC LIMIT 1), '') \
                     FROM agent_messages m LEFT JOIN agent_sessions s ON s.session_id = m.session_id \
                     WHERE (?1 = '' OR COALESCE(s.project, '') = ?1) \
                     GROUP BY m.session_id \
                     ORDER BY COALESCE(s.pinned, 0) DESC, MAX(m.at) DESC LIMIT ?2",
                )
                .map_err(map_sqlite_error)?;
            let rows = statement
                .query_map(params![project, limit.clamp(1, 200) as i64], |row| {
                    let custom: String = row.get(4)?;
                    let content: String = row.get(8)?;
                    let derived = serde_json::from_str::<serde_json::Value>(&content)
                        .ok()
                        .and_then(|value| {
                            value
                                .get("text")
                                .and_then(|text| text.as_str())
                                .map(str::to_owned)
                        })
                        .map(|text| title_of(&text))
                        .filter(|text| !text.is_empty())
                        .unwrap_or_else(|| "新会话".to_owned());
                    Ok(AgentSessionSummary {
                        session_id: row.get(0)?,
                        title: if custom.trim().is_empty() { derived } else { custom },
                        project: row.get(5)?,
                        backend: row.get(7)?,
                        pinned: row.get::<_, i64>(6)? != 0,
                        created_at: row.get(1)?,
                        last_at: row.get(2)?,
                        messages: row.get(3)?,
                    })
                })
                .map_err(map_sqlite_error)?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row.map_err(map_sqlite_error)?);
            }
            Ok(out)
        })
        .await
    }

    async fn touch_session(
        &self,
        session_id: &str,
        project: Option<&str>,
        at: Millis,
    ) -> Result<()> {
        let session_id = session_id.to_owned();
        let project = project.unwrap_or_default().to_owned();
        self.write(move |conn| {
            conn.execute(
                "INSERT INTO agent_sessions (session_id, title, project, pinned, created_at, updated_at) \
                 VALUES (?1, '', ?2, 0, ?3, ?3) \
                 ON CONFLICT(session_id) DO UPDATE SET \
                     updated_at = excluded.updated_at, \
                     project = CASE WHEN excluded.project != '' THEN excluded.project ELSE agent_sessions.project END",
                params![session_id, project, at],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn rename_session(&self, session_id: &str, title: &str, at: Millis) -> Result<bool> {
        let session_id = session_id.to_owned();
        let title = title.trim().to_owned();
        self.write(move |conn| {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM agent_messages WHERE session_id = ?1",
                    params![session_id],
                    |row| row.get(0),
                )
                .map_err(map_sqlite_error)?;
            if exists == 0 {
                return Ok(false);
            }
            conn.execute(
                "INSERT INTO agent_sessions (session_id, title, project, pinned, created_at, updated_at) \
                 VALUES (?1, ?2, '', 0, ?3, ?3) \
                 ON CONFLICT(session_id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at",
                params![session_id, title, at],
            )
            .map_err(map_sqlite_error)?;
            Ok(true)
        })
        .await
    }

    async fn pin_session(&self, session_id: &str, pinned: bool, at: Millis) -> Result<bool> {
        let session_id = session_id.to_owned();
        self.write(move |conn| {
            let exists: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM agent_messages WHERE session_id = ?1",
                    params![session_id],
                    |row| row.get(0),
                )
                .map_err(map_sqlite_error)?;
            if exists == 0 {
                return Ok(false);
            }
            conn.execute(
                "INSERT INTO agent_sessions (session_id, title, project, pinned, created_at, updated_at) \
                 VALUES (?1, '', '', ?2, ?3, ?3) \
                 ON CONFLICT(session_id) DO UPDATE SET pinned = excluded.pinned, updated_at = excluded.updated_at",
                params![session_id, i64::from(pinned), at],
            )
            .map_err(map_sqlite_error)?;
            Ok(true)
        })
        .await
    }

    async fn delete_session(&self, session_id: &str) -> Result<usize> {
        let session_id = session_id.to_owned();
        self.write(move |conn| {
            let deleted = conn
                .execute(
                    "DELETE FROM agent_messages WHERE session_id = ?1",
                    params![session_id],
                )
                .map_err(map_sqlite_error)?;
            conn.execute(
                "DELETE FROM agent_sessions WHERE session_id = ?1",
                params![session_id],
            )
            .map_err(map_sqlite_error)?;
            Ok(deleted)
        })
        .await
    }

    async fn session_meta(&self, session_id: &str) -> Result<AgentSessionMeta> {
        let session_id = session_id.to_owned();
        self.read(move |conn| {
            let row = conn.query_row(
                "SELECT backend, project, acp_agent, acp_session, summary, summary_upto, \
                        COALESCE(sandboxed, 1) \
                 FROM agent_sessions WHERE session_id = ?1",
                params![session_id],
                |row| {
                    Ok(AgentSessionMeta {
                        backend: row.get(0)?,
                        project: row.get(1)?,
                        acp_agent: row.get(2)?,
                        acp_session: row.get(3)?,
                        summary: row.get(4)?,
                        summary_upto: row.get(5)?,
                        sandboxed: row.get::<_, i64>(6)? != 0,
                    })
                },
            );
            match row {
                Ok(meta) => Ok(meta),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(AgentSessionMeta {
                    sandboxed: true,
                    ..AgentSessionMeta::default()
                }),
                Err(err) => Err(map_sqlite_error(err)),
            }
        })
        .await
    }

    async fn set_acp_session(
        &self,
        session_id: &str,
        agent: &str,
        acp_session: &str,
        at: Millis,
    ) -> Result<()> {
        let session_id = session_id.to_owned();
        let agent = agent.to_owned();
        let acp_session = acp_session.to_owned();
        self.write(move |conn| {
            conn.execute(
                "INSERT INTO agent_sessions (session_id, title, project, pinned, created_at, updated_at, backend, acp_agent, acp_session) \
                 VALUES (?1, '', '', 0, ?2, ?2, 'acp', ?3, ?4) \
                 ON CONFLICT(session_id) DO UPDATE SET \
                     backend = 'acp', acp_agent = excluded.acp_agent, \
                     acp_session = excluded.acp_session, updated_at = excluded.updated_at",
                params![session_id, at, agent, acp_session],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn set_sandboxed(&self, session_id: &str, sandboxed: bool, at: Millis) -> Result<()> {
        let session_id = session_id.to_owned();
        self.write(move |conn| {
            conn.execute(
                "UPDATE agent_sessions SET sandboxed = ?2, updated_at = ?3 WHERE session_id = ?1",
                params![session_id, if sandboxed { 1 } else { 0 }, at],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn set_summary(
        &self,
        session_id: &str,
        summary: &str,
        upto: i64,
        at: Millis,
    ) -> Result<()> {
        let session_id = session_id.to_owned();
        let summary = summary.to_owned();
        self.write(move |conn| {
            conn.execute(
                "INSERT INTO agent_sessions (session_id, title, project, pinned, created_at, updated_at, summary, summary_upto) \
                 VALUES (?1, '', '', 0, ?2, ?2, ?3, ?4) \
                 ON CONFLICT(session_id) DO UPDATE SET \
                     summary = excluded.summary, summary_upto = excluded.summary_upto, \
                     updated_at = excluded.updated_at",
                params![session_id, at, summary, upto],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }
}

/// 会话标题:第一条用户消息压成一行,最多 60 个字符。
fn title_of(text: &str) -> String {
    let line = text
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("");
    let mut title: String = line.trim().chars().take(60).collect();
    if line.trim().chars().count() > 60 {
        title.push('…');
    }
    title
}
