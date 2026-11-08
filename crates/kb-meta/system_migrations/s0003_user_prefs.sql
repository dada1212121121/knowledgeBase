-- 用户界面偏好(侧栏状态、密度等)。每人一行,整体替换;内容是前端自己定义的 JSON 对象,
-- 服务端只管大小与形状(见 SystemStore::set_prefs),不解释里面的键。
CREATE TABLE IF NOT EXISTS user_prefs (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
