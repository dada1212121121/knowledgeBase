-- 好友、拉黑、站内通知(多用户设计说明)。
-- 不设外键:用户注销时由 purge_user 显式删除(与其它表一致)。

CREATE TABLE IF NOT EXISTS friend_requests (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  message TEXT,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','accepted','rejected','ignored','expired')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS friend_requests_by_to ON friend_requests(to_id, state, created_at);
CREATE INDEX IF NOT EXISTS friend_requests_by_from ON friend_requests(from_id, state, created_at);

-- 双向各一行:每个人的好友列表只读自己那一行,备注和分组各记各的。
CREATE TABLE IF NOT EXISTS friendships (
  user_id TEXT NOT NULL,
  friend_id TEXT NOT NULL,
  remark TEXT,
  group_name TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, friend_id)
);
CREATE INDEX IF NOT EXISTS friendships_by_friend ON friendships(friend_id);

CREATE TABLE IF NOT EXISTS blocks (
  user_id TEXT NOT NULL,
  blocked_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, blocked_id)
);
CREATE INDEX IF NOT EXISTS blocks_by_blocked ON blocks(blocked_id);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  data_json TEXT NOT NULL,
  read_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notifications_by_user ON notifications(user_id, read_at, created_at);
