-- :多人在线编辑的协作状态(多用户设计说明)。
-- 存储格式仍是 Markdown / 文本;这两张表只是协作期间的中间态:一份快照 + 快照之后的增量更新。
CREATE TABLE IF NOT EXISTS collab_state (
    doc_id          TEXT PRIMARY KEY,           -- 资源键的规范字符串
    kind            TEXT NOT NULL,              -- text | prosemirror
    snapshot        BLOB NOT NULL DEFAULT x'',  -- Yjs 完整状态(v1)
    materialized_sv BLOB,                       -- 最近一次落地时客户端提交的状态向量
    landed_hash     TEXT,                       -- 最近一次落地的正文哈希(判断正文有没有被别的途径改过)
    materialized_at INTEGER,
    updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS collab_updates (
    doc_id      TEXT NOT NULL,
    seq         INTEGER NOT NULL,
    update_blob BLOB NOT NULL,
    user_id     TEXT NOT NULL,                  -- 产生这批更新的人,排查用
    at          INTEGER NOT NULL,
    PRIMARY KEY (doc_id, seq)
) WITHOUT ROWID;
