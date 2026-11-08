-- 文档链接图谱:正文里的相对链接 / 双链 / 附件引用,用于反向链接和删除、移动前的影响提示。
--
-- 只存解析结果,不存文件内容。`source_kind` 是 file 或 note:
--   * file 的 source_id 是 collection 内路径;
--   * note 的 source_id 是笔记 id。
-- `target_kind` 是 file / note / external / anchor / invalid;前两种才有 target_collection / target_id。
-- 同一篇文档里同一个 href 只留一行(第一次出现的行号),避免重复链接把清单刷满。
CREATE TABLE IF NOT EXISTS doc_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('file','note')),
  source_collection TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_title TEXT NOT NULL DEFAULT '',
  href TEXT NOT NULL,
  line INTEGER NOT NULL DEFAULT 0,
  label TEXT,
  target_kind TEXT NOT NULL DEFAULT 'invalid',
  target_collection TEXT,
  target_id TEXT,
  reason TEXT,
  indexed_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS doc_links_unique
  ON doc_links(source_kind, source_collection, source_id, href);
CREATE INDEX IF NOT EXISTS doc_links_by_target
  ON doc_links(target_kind, target_collection, target_id);
CREATE INDEX IF NOT EXISTS doc_links_by_source
  ON doc_links(source_kind, source_collection, source_id);

-- 每篇文档最近一次解析链接的时间 / 文件 mtime。启动后按需补建:只重解析 mtime 变过的文件。
CREATE TABLE IF NOT EXISTS doc_link_sources (
  source_kind TEXT NOT NULL CHECK (source_kind IN ('file','note')),
  source_collection TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_title TEXT NOT NULL DEFAULT '',
  mtime INTEGER NOT NULL DEFAULT 0,
  indexed_at INTEGER NOT NULL,
  PRIMARY KEY (source_kind, source_collection, source_id)
);
