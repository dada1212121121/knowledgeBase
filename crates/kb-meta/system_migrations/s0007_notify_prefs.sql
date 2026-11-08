-- 通知的邮件偏好与合并发送队列(多用户设计说明)。
-- 站内通知永远有;邮件按「种类」让用户开关,没设过的按种类的默认值(见 kb_core::social::kind::email_by_default)。
CREATE TABLE IF NOT EXISTS notify_prefs (
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  email INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind)
);

-- 等着合并成一封邮件的通知。同一个人 10 分钟内的多条合并成一封,所以先排队、由定时任务汇总发送。
CREATE TABLE IF NOT EXISTS notify_mail_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  notification_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notify_mail_queue_by_user ON notify_mail_queue(user_id, created_at);

-- 每个人上一封通知邮件什么时候发的(用来控制「最多每 10 分钟一封」)。
CREATE TABLE IF NOT EXISTS notify_mail_state (
  user_id TEXT PRIMARY KEY,
  last_sent_at INTEGER NOT NULL
);
