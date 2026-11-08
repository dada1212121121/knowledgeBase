-- :文本类在线编辑的版本历史。
-- 每次保存生成一行(恢复旧版本也生成新行),`body` 存整份文本,便于对比与恢复。
CREATE TABLE IF NOT EXISTS item_versions (
    id          TEXT PRIMARY KEY,
    item_id     TEXT NOT NULL,
    collection  TEXT NOT NULL,
    source      TEXT NOT NULL,
    version     INTEGER NOT NULL,
    title       TEXT,
    body        TEXT NOT NULL,
    tags        TEXT NOT NULL DEFAULT '',
    author      TEXT,
    batch_id    TEXT,
    created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_item_versions_item ON item_versions(item_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_item_versions_source ON item_versions(collection, source, version DESC);
