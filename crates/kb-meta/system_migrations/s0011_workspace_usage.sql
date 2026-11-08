-- 代理工作目录(agent-workspace)占用也计入配额,单独成一项。
ALTER TABLE space_usage ADD COLUMN workspace_bytes INTEGER NOT NULL DEFAULT 0;
