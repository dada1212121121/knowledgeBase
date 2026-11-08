-- 收尾:草稿记住候选的关联文件。
-- 此前 drafts 没有 related_paths 列,进收件箱的草稿在人工确认转正时会丢掉关联路径
-- (提炼结果里有,落库时被丢弃)。这里只加一列,旧行默认空数组。
ALTER TABLE drafts ADD COLUMN related_paths_json TEXT NOT NULL DEFAULT '[]';
