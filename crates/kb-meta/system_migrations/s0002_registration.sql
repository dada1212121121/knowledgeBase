-- s0002_registration.sql —— 邮箱验证码、邀请码、发信记录(多用户设计说明)

-- 邮箱验证码:库里只存 sha256(pepper + 邮箱 + 用途 + 验证码),泄露了库也还原不出有效验证码
CREATE TABLE email_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('register','reset','change_email')),
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  ip TEXT,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX email_codes_by_email ON email_codes(email, purpose, created_at);
CREATE INDEX email_codes_by_ip ON email_codes(ip, created_at);

-- 邀请码:同样只存哈希;prefix 是前 7 位(KB-7H2K),给管理员认人用
CREATE TABLE invite_codes (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,
  created_by TEXT,
  note TEXT NOT NULL DEFAULT '',
  max_uses INTEGER NOT NULL DEFAULT 1,
  used INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  role_id TEXT REFERENCES roles(id) ON DELETE SET NULL,   -- 用这个码注册后的角色;空 = 系统默认角色
  quota_json TEXT NOT NULL DEFAULT '{}',                   -- 用这个码注册后的配额覆盖
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE invite_uses (
  invite_id TEXT NOT NULL REFERENCES invite_codes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  ip TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX invite_uses_by_invite ON invite_uses(invite_id);

-- 发信记录(不做重试队列:验证码晚到 30 分钟就没用了,用户重新点「获取验证码」即可)
CREATE TABLE mail_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  to_addr TEXT NOT NULL,
  kind TEXT NOT NULL,
  ok INTEGER NOT NULL,
  via TEXT,                       -- primary | backup
  error TEXT
);
CREATE INDEX mail_log_by_time ON mail_log(at);
