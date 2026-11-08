-- 任务处理过的文件:任务详情里「改动的文件」清单(路径、变化类型、写入块数、失败原因)。
--
-- 为什么不放进 jobs.checkpoint_json:检查点每个分片都要整份重写,一个几千文件的全量索引
-- 会把这一行反复写到几百 KB;而且任务列表/详情都不需要读它。单独一张表按 (job_id, path)
-- 主键,分片结束时批量 upsert,续跑重写同一个路径也还是同一行。
CREATE TABLE IF NOT EXISTS job_files (
  job_id TEXT NOT NULL,
  path TEXT NOT NULL,
  -- new(新增) / update(内容更新) / meta(只改了元数据) / delete(删除) / skip(指纹没变) / error(失败)
  change TEXT NOT NULL,
  -- 新写入 / 重新嵌入的块数
  chunks INTEGER NOT NULL DEFAULT 0,
  -- 只更新元数据的块数
  meta_chunks INTEGER NOT NULL DEFAULT 0,
  -- 删掉的旧块数
  deleted_chunks INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  done_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, path)
);
-- 详情按变化类型排序、按变化类型统计都只查一个任务
CREATE INDEX IF NOT EXISTS job_files_by_job ON job_files(job_id, change);
