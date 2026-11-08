-- 文档授权(多用户设计说明)。
-- resource_key 是 kb_core::share::ResourceKey 的规范字符串;space_id 冗余存一份,
-- 注销账号时能按知识库一次删干净,「我的分享」也能按知识库直接查。

CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  grantee_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('viewer','commenter','editor','manager')),
  via TEXT NOT NULL DEFAULT 'direct',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  UNIQUE (resource_key, grantee_id)
);
CREATE INDEX IF NOT EXISTS grants_by_grantee ON grants(grantee_id, space_id);
CREATE INDEX IF NOT EXISTS grants_by_space ON grants(space_id, resource_key);

-- 「不继承上级协作者」:这一层只认自己的授权。
CREATE TABLE IF NOT EXISTS inherit_breaks (
  resource_key TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS inherit_breaks_by_space ON inherit_breaks(space_id);

-- 「共享给我」里被我移出列表的(只是不显示,不影响授权)。
CREATE TABLE IF NOT EXISTS hidden_shares (
  user_id TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  PRIMARY KEY (user_id, resource_key)
);

-- 访问申请:没有权限的人向所有者 / 可管理的人要权限。
CREATE TABLE IF NOT EXISTS access_requests (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  resource_key TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('viewer','commenter','editor')),
  message TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','rejected')),
  decided_by TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS access_requests_by_key ON access_requests(resource_key, state);
CREATE INDEX IF NOT EXISTS access_requests_by_requester ON access_requests(requester_id, resource_key, created_at);
CREATE INDEX IF NOT EXISTS access_requests_by_space ON access_requests(space_id, state);
