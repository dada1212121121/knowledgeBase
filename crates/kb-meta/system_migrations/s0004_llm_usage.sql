-- 每个用户每天的 LLM 用量(按用途分行)。额度检查读「某人某天的合计」,管理员排行读「某天按人合计」。
-- 不设外键:用户注销时由 purge_user 显式删除。
CREATE TABLE IF NOT EXISTS llm_user_usage (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  purpose TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, purpose)
);
CREATE INDEX IF NOT EXISTS llm_user_usage_by_day ON llm_user_usage(day, user_id);
