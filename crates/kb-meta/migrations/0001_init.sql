-- 0001_init.sql —— 初始表结构(初始表结构)
-- 时间统一用 Unix 毫秒(INTEGER);JSON 字段用 TEXT 存储。
-- 版本记录在 PRAGMA user_version 里,由 kb-meta/src/migrate.rs 按顺序执行。

CREATE TABLE projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, slug TEXT NOT NULL UNIQUE,
  root_path TEXT NOT NULL UNIQUE, include_json TEXT NOT NULL DEFAULT '[]', exclude_json TEXT NOT NULL DEFAULT '[]',
  is_git INTEGER NOT NULL DEFAULT 0, last_commit TEXT, last_indexed_at INTEGER,
  allow_cloud_llm INTEGER NOT NULL DEFAULT 0, extract_enabled INTEGER NOT NULL DEFAULT 0,
  hooks_installed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);

CREATE TABLE collections (
  name TEXT PRIMARY KEY,                         -- _global | proj_<slug> | ext_<slug>
  kind TEXT NOT NULL CHECK (kind IN ('global','project','external')),
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  embedder_id TEXT NOT NULL, dim INTEGER NOT NULL,
  active_table TEXT NOT NULL,                    -- 物理表指针,如 proj_x__fastembedbgem3int8__v1
  table_version INTEGER NOT NULL DEFAULT 1,
  migrating_to TEXT, migration_started_at INTEGER,
  retired_tables_json TEXT NOT NULL DEFAULT '[]',-- 待延迟删除的旧表
  context_mode TEXT NOT NULL DEFAULT 'header' CHECK (context_mode IN ('header','llm')),
  created_at INTEGER NOT NULL);

CREATE TABLE files (                             -- 文件级指纹(快速跳过未变化的文件)
  collection TEXT NOT NULL REFERENCES collections(name) ON DELETE CASCADE,
  path TEXT NOT NULL, file_hash TEXT NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL,
  indexed_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'ok', error TEXT,
  PRIMARY KEY (collection, path));

CREATE TABLE chunks ( -- 块级三哈希,用于 diff,不必扫描 LanceDB
  id TEXT PRIMARY KEY, collection TEXT NOT NULL, path TEXT NOT NULL, ordinal INTEGER NOT NULL,
  content_hash TEXT NOT NULL, meta_hash TEXT NOT NULL, embed_input_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL);
CREATE INDEX chunks_by_path ON chunks(collection, path);
CREATE INDEX chunks_by_updated ON chunks(collection, updated_at);

CREATE TABLE insights (                          -- insight 的权威数据(正文与版本),LanceDB 只存检索副本
  id TEXT PRIMARY KEY, collection TEXT NOT NULL, title TEXT NOT NULL, body_md TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'note',             -- decision|pitfall|howto|convention|note
  tags_json TEXT NOT NULL DEFAULT '[]', related_paths_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','deprecated')),
  version INTEGER NOT NULL DEFAULT 1, valid_from INTEGER NOT NULL, valid_until INTEGER,
  superseded_by TEXT REFERENCES insights(id), created_by TEXT NOT NULL,  -- user|mcp:<client>|agent|extractor:<id>
  batch_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);

CREATE TABLE drafts (                            -- 设计规范草稿: 永远不进 LanceDB
  id TEXT PRIMARY KEY, collection TEXT NOT NULL, title TEXT NOT NULL, body_md TEXT NOT NULL,
  kind TEXT NOT NULL, tags_json TEXT NOT NULL DEFAULT '[]', evidence_json TEXT NOT NULL,
  extractor_id TEXT NOT NULL, event_id TEXT REFERENCES events(id),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','revised','rejected','duplicate')),
  review_json TEXT, insight_id TEXT, created_at INTEGER NOT NULL, decided_at INTEGER);

CREATE TABLE events (                            -- 进化事件: git_commit|git_merge|git_checkout|session_end|file_change|manual
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, project_id TEXT, payload_json TEXT NOT NULL,
  received_at INTEGER NOT NULL, processed_at INTEGER, result TEXT);

CREATE TABLE edges (                             -- 设计规范轻量关系
  src_id TEXT NOT NULL, dst TEXT NOT NULL,       -- dst = 记录 id 或 "path:<相对路径>" 或 "commit:<sha>"
  rel TEXT NOT NULL,                             -- about_file|references|from_commit|supersedes|derived_from|duplicate_of
  created_at INTEGER NOT NULL, PRIMARY KEY (src_id, dst, rel));
CREATE INDEX edges_by_dst ON edges(dst);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, collection TEXT, priority INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','running','paused','done','failed','canceled')),
  payload_json TEXT NOT NULL, checkpoint_json TEXT, progress_done INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER, rate REAL, error TEXT,
  created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER);
CREATE INDEX jobs_pending ON jobs(state, priority DESC, created_at);

CREATE TABLE batches (id TEXT PRIMARY KEY, actor TEXT NOT NULL, description TEXT NOT NULL,
  created_at INTEGER NOT NULL, reverted_at INTEGER);
CREATE TABLE changes (batch_id TEXT NOT NULL REFERENCES batches(id), seq INTEGER NOT NULL,
  target TEXT NOT NULL, before_json TEXT, after_json TEXT, PRIMARY KEY (batch_id, seq));

CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL,
  capability TEXT NOT NULL, args_json TEXT NOT NULL,      -- 存脱敏后的参数
  ok INTEGER NOT NULL, error TEXT, batch_id TEXT, dry_run INTEGER NOT NULL DEFAULT 0);

CREATE TABLE feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, query TEXT NOT NULL,
  item_id TEXT NOT NULL, useful INTEGER NOT NULL, note TEXT, source TEXT NOT NULL);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);  -- password_hash 等
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, last_seen INTEGER NOT NULL, user_agent TEXT);
CREATE TABLE api_tokens (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL DEFAULT 'mcp', created_at INTEGER NOT NULL, last_used INTEGER, revoked_at INTEGER);

CREATE TABLE llm_usage (day TEXT NOT NULL, model TEXT NOT NULL, purpose TEXT NOT NULL,
  calls INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
  PRIMARY KEY (day, model, purpose));
CREATE TABLE llm_sends (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, project_id TEXT,
  purpose TEXT NOT NULL, chars INTEGER NOT NULL, redactions INTEGER NOT NULL); -- 发送审计
CREATE TABLE chunk_context (content_hash TEXT PRIMARY KEY, context TEXT NOT NULL, model TEXT NOT NULL,
  created_at INTEGER NOT NULL);                  -- 设计规范#1 LLM 上下文缓存
CREATE TABLE agent_messages (session_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL,
  content_json TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (session_id, seq));
