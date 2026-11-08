-- 会话事件的去重窗口按 kind 查:
-- `recent_by_kind` 之前是全表 SCAN + 排序,events 表会随 file_change 事件增长。
CREATE INDEX IF NOT EXISTS events_by_kind ON events(kind, received_at);
