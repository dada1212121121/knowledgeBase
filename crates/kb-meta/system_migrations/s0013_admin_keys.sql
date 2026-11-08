-- 每个用户一把 admin key:用它能以本人身份调用本人权限内的全部接口(含创建 MCP 访问令牌)。
-- 明文存放:设置页和「AI 接入指南」要随时把它显示出来 / 写进下载的文档,哈希做不到;靠 system.db 的文件权限(0600)和备份的访问控制。
-- 一人一把;轮换 = 原地换新值,旧值立刻失效。
CREATE TABLE IF NOT EXISTS user_admin_keys (
  user_id    TEXT PRIMARY KEY,
  admin_key  TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  rotated_at INTEGER
);

-- 给已有用户补发。格式与 kb_core::token::new_admin_key 一致:kb_ak_ + 48 位十六进制。
-- randomblob 在每一行上单独求值,所以每人一把不同的 key。
INSERT OR IGNORE INTO user_admin_keys (user_id, admin_key, created_at)
SELECT id, 'kb_ak_' || lower(hex(randomblob(24))), CAST(strftime('%s', 'now') AS INTEGER) * 1000 FROM users;
