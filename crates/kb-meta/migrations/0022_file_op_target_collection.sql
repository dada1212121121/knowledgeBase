-- 跨知识库移动要能回答「从哪来、到哪去」:源 collection 仍在 collection 列,
-- 这里补上目标 collection。同库移动 / 删除 / 恢复 / 清理保持 NULL。
ALTER TABLE file_ops ADD COLUMN target_collection TEXT;
