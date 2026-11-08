-- :批注(锚定到页 / 单元格 / 幻灯片 / 时间点),同时进入检索。
CREATE TABLE IF NOT EXISTS annotations (
    id          TEXT PRIMARY KEY,
    collection  TEXT NOT NULL,
    source      TEXT NOT NULL,
    anchor_json TEXT,
    body        TEXT NOT NULL,
    author      TEXT,
    record_id   TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_annotations_source ON annotations(collection, source, created_at DESC);
