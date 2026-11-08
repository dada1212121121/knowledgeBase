-- :自动提炼的指纹去重与“不再提炼”排除表。
-- 0001 里已提交的 drafts 表结构不改,这里只加列(带默认值,旧行不受影响)。
ALTER TABLE drafts ADD COLUMN fingerprint TEXT NOT NULL DEFAULT '';
ALTER TABLE drafts ADD COLUMN embedding BLOB;
ALTER TABLE drafts ADD COLUMN embedder_id TEXT;

CREATE INDEX IF NOT EXISTS idx_drafts_fingerprint ON drafts(collection, fingerprint);

-- “不再提炼”:只存指纹、向量与原因,不存标题和正文(设计规范的隐私要求)。
CREATE TABLE IF NOT EXISTS evolution_exclusions (
    collection  TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    embedding   BLOB,
    embedder_id TEXT,
    reason      TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (collection, fingerprint)
);
