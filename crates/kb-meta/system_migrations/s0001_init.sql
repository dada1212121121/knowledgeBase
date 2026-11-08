-- s0001_init.sql —— system.db 初始表结构(多用户设计说明, 用到的部分)
-- 与每个知识库的 meta.db 分开:这里只放账号、角色、会话、令牌、系统审计。时间统一 Unix 毫秒。
-- 版本记录在 PRAGMA user_version,由 kb-meta/src/system/migrate.rs 顺序执行。

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE roles (
  id TEXT PRIMARY KEY,                       -- role_admin | role_user | role_<uuid7>
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  builtin INTEGER NOT NULL DEFAULT 0,        -- 内置角色不能删
  all_features INTEGER NOT NULL DEFAULT 0,   -- 管理员:拥有全部功能(含以后新增的)
  dangerous INTEGER NOT NULL DEFAULT 0,      -- 允许授予危险(系统级)功能
  quota_json TEXT NOT NULL DEFAULT '{}',     -- 覆盖系统参数里的默认配额
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE role_features (
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  feature TEXT NOT NULL,
  PRIMARY KEY (role_id, feature)
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,                       -- usr_<uuid7>
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email TEXT UNIQUE COLLATE NOCASE,
  email_verified_at INTEGER,
  display_name TEXT NOT NULL,
  avatar TEXT,
  password_hash TEXT NOT NULL,               -- argon2id;只经 SystemStore::password_hash 读取
  role_id TEXT NOT NULL REFERENCES roles(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','pending_email','disabled','deleting')),
  totp_secret_enc TEXT,
  privacy_json TEXT NOT NULL DEFAULT '{}',
  quota_json TEXT NOT NULL DEFAULT '{}',
  must_change_password INTEGER NOT NULL DEFAULT 0,
  registered_via TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER,
  delete_after INTEGER
);
CREATE INDEX users_by_role ON users(role_id);
CREATE INDEX users_by_status ON users(status);

CREATE TABLE user_feature_overrides (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feature TEXT NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('allow','deny')),
  PRIMARY KEY (user_id, feature)
);

CREATE TABLE spaces (
  id TEXT PRIMARY KEY,                       -- sp_<uuid7>,同时是 spaces/<id>/ 目录名
  owner_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'personal' CHECK (kind IN ('personal','team')),
  storage_bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
-- 每个用户只有一个个人知识库
CREATE UNIQUE INDEX spaces_one_personal_per_owner ON spaces(owner_id) WHERE kind = 'personal';

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX sessions_by_user ON sessions(user_id);
CREATE INDEX sessions_by_expiry ON sessions(expires_at);

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL DEFAULT 'mcp',
  include_shared INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_used INTEGER,
  revoked_at INTEGER,
  UNIQUE (user_id, name)
);

CREATE TABLE system_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  user_id TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  ip TEXT
);
CREATE INDEX system_audit_by_time ON system_audit(at);
CREATE INDEX system_audit_by_user ON system_audit(user_id, at);
