-- 文本优先索引:已经写进 LanceDB、但向量还空着的块。
--
-- 为什么不只靠 LanceDB 的 `embed_state`:检索路径每个请求都要判断「这个 collection 有没有
-- 待补向量」,扫一遍向量表太贵。这张表是待嵌入队列的 SQLite 侧索引,`has_pending` 走
-- (collection) 主键前缀,开销是一次本地主键查询。
--
-- chunk_id 不做外键:`replace_for_path` 在同一个事务里清队列,删除文件 / 集合时也显式清理;
-- 外键加上 ON DELETE CASCADE 反而会在批量替换块时多一次索引维护。
CREATE TABLE IF NOT EXISTS pending_embeds (
  collection TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  -- 冗余路径:按文件清理队列时不用回 chunks 表(块已经被替换掉时也能清)
  path TEXT NOT NULL,
  enqueued_at INTEGER NOT NULL,
  PRIMARY KEY (collection, chunk_id)
);

-- 按入队顺序取一批补向量;path 索引给「文件被删 / 被改」时按路径清队列
CREATE INDEX IF NOT EXISTS pending_embeds_by_time ON pending_embeds(collection, enqueued_at, chunk_id);
CREATE INDEX IF NOT EXISTS pending_embeds_by_path ON pending_embeds(collection, path);
