-- 两步验证(TOTP)。密钥以 base32 明文存放:验证时必须能还原,加密密钥又只能放在同一个库里(盐 / pepper),
-- 加了也防不住拿到库文件的人;所以靠文件权限(0600)和备份的访问控制,不做表面功夫。
CREATE TABLE IF NOT EXISTS user_totp (
  user_id      TEXT PRIMARY KEY,
  secret_b32   TEXT NOT NULL,
  confirmed_at INTEGER,          -- NULL = 还在设置中(没有验证过第一个码),不参与登录
  last_step    INTEGER,          -- 已经用掉的最大时间步,防止同一个码被重放
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_recovery_codes (
  user_id   TEXT NOT NULL,
  code_hash TEXT NOT NULL,       -- sha256(pepper + 规整后的恢复码)
  used_at   INTEGER,
  PRIMARY KEY (user_id, code_hash)
);
