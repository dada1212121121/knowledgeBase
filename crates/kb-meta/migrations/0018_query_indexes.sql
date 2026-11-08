-- 「最近的 N 条任务」按创建时间倒序取:没有这个索引就是全表排序(任务表会涨到上万条)。
CREATE INDEX IF NOT EXISTS jobs_by_created ON jobs(created_at);

-- insights 之前一个索引都没有:按 collection 分页要全表扫描再排序,「近 7 天新增」也是全表扫描。
CREATE INDEX IF NOT EXISTS insights_by_collection ON insights(collection, updated_at DESC);
CREATE INDEX IF NOT EXISTS insights_by_created ON insights(created_at);
