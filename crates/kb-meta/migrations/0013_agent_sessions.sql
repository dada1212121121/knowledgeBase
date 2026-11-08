-- AI 管家会话的元数据:自定义标题、所属项目、置顶。
-- 消息本身仍在 agent_messages;老库里的会话没有这一行,列表接口会回退到
-- 「首条用户消息」当标题、project 为空。
CREATE TABLE IF NOT EXISTS agent_sessions (
    session_id TEXT PRIMARY KEY,
    title      TEXT NOT NULL DEFAULT '',
    project    TEXT NOT NULL DEFAULT '',
    pinned     INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_pinned ON agent_sessions(pinned, updated_at);
