-- 0002_sources_uploads.sql —— 数据源与上传
-- 四张表:sources(数据源)、uploads / upload_parts(分片续传)、ingest_files(解析队列)。
-- 时间统一用 Unix 毫秒(INTEGER);JSON 字段用 TEXT 存储。

CREATE TABLE sources (                           -- 数据源:本地目录 / git / 网页 / 上传 / 压缩包 / 笔记
  id TEXT PRIMARY KEY, kind TEXT NOT NULL,
  name TEXT NOT NULL UNIQUE, uri TEXT NOT NULL,
  collection TEXT NOT NULL REFERENCES collections(name) ON DELETE CASCADE,
  tags_json TEXT NOT NULL DEFAULT '[]', include_json TEXT NOT NULL DEFAULT '[]',
  exclude_json TEXT NOT NULL DEFAULT '[]',
  depth INTEGER NOT NULL DEFAULT 1,              -- 网页抓取深度(1..3)
  allow_hosts_json TEXT NOT NULL DEFAULT '[]',   -- 网页域名白名单
  refresh_minutes INTEGER,                       -- 定时刷新;NULL = 不自动刷新
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle','syncing','error')),
  last_synced_at INTEGER, last_error TEXT,
  files INTEGER NOT NULL DEFAULT 0,              -- 已入库文件数(冗余统计)
  created_at INTEGER NOT NULL);
CREATE INDEX sources_by_collection ON sources(collection);

CREATE TABLE uploads (                           -- 一次分片上传(一个文件一条)
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  rel_path TEXT NOT NULL,                        -- 集合内相对路径(文件夹上传保留目录结构)
  collection TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  size INTEGER NOT NULL, sha256 TEXT,            -- 客户端声明的整体哈希(可空)
  chunk_size INTEGER NOT NULL, parts_total INTEGER NOT NULL,
  parts_received INTEGER NOT NULL DEFAULT 0,     -- 冗余统计;续传按 upload_parts 判断
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','completed','aborted')),
  source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
  batch_id TEXT,                                 -- 一次上传 = 一个 batch,可整批撤销
  strategy TEXT,                                 -- skip | overwrite | keep_both(空 = skip)
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER);
CREATE INDEX uploads_pending ON uploads(state, updated_at);

CREATE TABLE upload_parts (                      -- 已收到的分片(续传据此跳过)
  upload_id TEXT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  part_no INTEGER NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (upload_id, part_no));

CREATE TABLE ingest_files (                      -- 解析队列:每个待入库文件一条
  id TEXT PRIMARY KEY, batch_id TEXT, source_id TEXT, upload_id TEXT,
  collection TEXT NOT NULL,
  rel_path TEXT NOT NULL,                        -- 同时也是检索结果里的 source
  abs_path TEXT NOT NULL,                        -- 落盘位置
  size INTEGER NOT NULL, sha256 TEXT,
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued','extracting','chunking','embedding','done','failed','quarantined')),
  error TEXT, chunks INTEGER NOT NULL DEFAULT 0, vectors INTEGER NOT NULL DEFAULT 0,
  elapsed_ms INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (collection, rel_path));
CREATE INDEX ingest_by_state ON ingest_files(state, created_at);
CREATE INDEX ingest_by_batch ON ingest_files(batch_id);
CREATE INDEX ingest_by_source ON ingest_files(source_id);
CREATE INDEX ingest_by_sha ON ingest_files(collection, sha256);
