-- 文件操作流水(删除 / 移动)、回收站与同步排除。
--
-- 为什么要单独记流水:一次删除文件夹会移动几十个文件,进程中途被杀时必须知道
-- 哪些已经搬走、哪些还没处理;恢复和回滚都靠这张表,而不是靠内存里的进度。

CREATE TABLE IF NOT EXISTS file_ops (
  id TEXT PRIMARY KEY,
  collection TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('delete_file','delete_folder','move_file','move_files','move_folder','restore','purge')),
  state TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running','done','partial','failed','rolled_back')),
  total INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS file_ops_by_collection ON file_ops(collection, created_at);

-- 回收站条目。
-- metadata_key 是版本 / 批注在隐藏期间的归属键(`trash:<id>`):旧路径可以立即复用,
-- 恢复时再改回原路径。mode=unindex 的行没有物理文件(本地目录 / 项目 / Web / Git),
-- 只用于让「我删过它」这件事在同步再次扫到时仍然可见。
CREATE TABLE IF NOT EXISTS trash_entries (
  id TEXT PRIMARY KEY,
  op_id TEXT NOT NULL REFERENCES file_ops(id) ON DELETE CASCADE,
  collection TEXT NOT NULL,
  original_path TEXT NOT NULL,
  trash_path TEXT,
  source_id TEXT,
  metadata_key TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('trash','unindex')),
  size INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  restored_at INTEGER,
  purged_at INTEGER
);
CREATE INDEX IF NOT EXISTS trash_entries_by_op ON trash_entries(op_id);
CREATE INDEX IF NOT EXISTS trash_entries_by_collection ON trash_entries(collection, created_at);
CREATE INDEX IF NOT EXISTS trash_entries_by_expiry ON trash_entries(expires_at);

-- 同步排除标记:按「文件」精确记录,不用目录前缀,否则删掉 docs/a.md 会连 docs/b.md 也排除。
-- source_id 对本地 / Web / Git 是数据源 id;项目文件用 `project:<项目 id>`。
CREATE TABLE IF NOT EXISTS path_exclusions (
  collection TEXT NOT NULL,
  source_id TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (collection, source_id, path)
);
