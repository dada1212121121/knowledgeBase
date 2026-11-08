-- 每个知识库的占用明细(定时统计写入)。`spaces.storage_bytes` 仍保留合计,这里是分项,
-- 管理员的「存储」排行和用户自己的用量页都读它,不用现场去数磁盘。
CREATE TABLE IF NOT EXISTS space_usage (
  space_id TEXT PRIMARY KEY,
  sources_bytes INTEGER NOT NULL DEFAULT 0,
  uploads_bytes INTEGER NOT NULL DEFAULT 0,
  vectors_bytes INTEGER NOT NULL DEFAULT 0,
  meta_bytes INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER NOT NULL DEFAULT 0,
  measured_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS space_usage_by_total ON space_usage(total_bytes DESC);
