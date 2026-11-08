-- (.7):评论回复、@ 提及、已解决。
-- 回复只有一层;已解决只对顶层评论有意义,回复跟着它走。
ALTER TABLE annotations ADD COLUMN parent_id TEXT;
ALTER TABLE annotations ADD COLUMN resolved_at INTEGER;
ALTER TABLE annotations ADD COLUMN resolved_by TEXT;
ALTER TABLE annotations ADD COLUMN mentions_json TEXT NOT NULL DEFAULT '[]';
CREATE INDEX IF NOT EXISTS idx_annotations_parent ON annotations(parent_id);
