-- 会话的代理是不是跑在沙箱里。旧行默认 1(当时没有“未隔离”标记)。
ALTER TABLE agent_sessions ADD COLUMN sandboxed INTEGER NOT NULL DEFAULT 1;
