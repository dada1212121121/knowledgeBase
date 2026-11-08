-- 分享链接与游客(多用户设计说明)。库里只有令牌的 sha256,明文只在创建 / 重置时返回一次。

CREATE TABLE IF NOT EXISTS share_links (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  token_hint TEXT NOT NULL,
  space_id TEXT NOT NULL,
  resource_key TEXT,
  title TEXT,
  audience TEXT NOT NULL CHECK (audience IN ('collaborators','logged_in','anyone')),
  role TEXT NOT NULL CHECK (role IN ('viewer','commenter','editor')),
  password_hash TEXT,
  expires_at INTEGER,
  allow_download INTEGER NOT NULL DEFAULT 1,
  watermark INTEGER NOT NULL DEFAULT 0,
  allow_reshare INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  views INTEGER NOT NULL DEFAULT 0,
  last_view_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS share_links_by_creator ON share_links(created_by, revoked_at);
CREATE INDEX IF NOT EXISTS share_links_by_space ON share_links(space_id);
CREATE INDEX IF NOT EXISTS share_links_by_resource ON share_links(resource_key);

-- 合集链接:一个链接指向多个资源(虚拟目录)。
CREATE TABLE IF NOT EXISTS share_link_items (
  link_id TEXT NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
  resource_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (link_id, resource_key)
);

-- 匿名访客:cookie 里的随机串的哈希,以及他自己起的昵称。
CREATE TABLE IF NOT EXISTS guests (
  id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL,
  first_link_id TEXT,
  ip TEXT,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

-- 登录访问者名单(匿名的只记次数,在 share_links.views 里)。
CREATE TABLE IF NOT EXISTS link_visitors (
  link_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  visits INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (link_id, user_id)
);

-- 游客链接每天的下载流量(按链接按天累计,用来挡「拿分享链接当下载站」)。
CREATE TABLE IF NOT EXISTS link_daily_bytes (
  link_id TEXT NOT NULL,
  day TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (link_id, day)
);
