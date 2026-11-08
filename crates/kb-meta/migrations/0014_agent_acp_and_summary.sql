-- 管家会话:ACP 后端与上下文压缩。
-- backend = builtin(内置模型)/ acp(外部 ACP 代理);acp_agent / acp_session 记住代理侧会话;
-- summary / summary_upto 存「较早对话的摘要」,长会话不再整段塞给模型。
ALTER TABLE agent_sessions ADD COLUMN backend TEXT NOT NULL DEFAULT 'builtin';
ALTER TABLE agent_sessions ADD COLUMN acp_agent TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_sessions ADD COLUMN acp_session TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_sessions ADD COLUMN summary TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_sessions ADD COLUMN summary_upto INTEGER NOT NULL DEFAULT 0;
