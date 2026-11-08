-- 0003_ingest_progress.sql —— 批次流水线进度
--
-- 1. 重建 ingest_files:状态里加上 `skipped`(skip_file 用)。
--    SQLite 不能改 CHECK 约束,只能建新表 → 搬数据 → 换名。
-- 2. ingest_stage_events:每个文件在每个阶段的耗时与产出(块 / 向量)。
-- 3. ingest_batches:批次的流水线状态(暂停 / 取消要能跨进程重启保持)。

CREATE TABLE ingest_files_new (
  id TEXT PRIMARY KEY, batch_id TEXT, source_id TEXT, upload_id TEXT,
  collection TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  abs_path TEXT NOT NULL,
  size INTEGER NOT NULL, sha256 TEXT,
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued','extracting','chunking','embedding','done','failed','quarantined','skipped')),
  error TEXT, chunks INTEGER NOT NULL DEFAULT 0, vectors INTEGER NOT NULL DEFAULT 0,
  elapsed_ms INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (collection, rel_path));

INSERT INTO ingest_files_new (id, batch_id, source_id, upload_id, collection, rel_path, abs_path,
       size, sha256, state, error, chunks, vectors, elapsed_ms, created_at, updated_at)
SELECT id, batch_id, source_id, upload_id, collection, rel_path, abs_path,
       size, sha256, state, error, chunks, vectors, elapsed_ms, created_at, updated_at
FROM ingest_files;

DROP TABLE ingest_files;
ALTER TABLE ingest_files_new RENAME TO ingest_files;
CREATE INDEX ingest_by_state ON ingest_files(state, created_at);
CREATE INDEX ingest_by_batch ON ingest_files(batch_id);
CREATE INDEX ingest_by_source ON ingest_files(source_id);
CREATE INDEX ingest_by_sha ON ingest_files(collection, sha256);

CREATE TABLE ingest_stage_events (               -- 一个文件在一个阶段的耗时与产出
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id TEXT NOT NULL,
  batch_id TEXT,
  stage TEXT NOT NULL
    CHECK (stage IN ('upload','detect','extract','chunk','embed','write','searchable')),
  started_at INTEGER NOT NULL, ended_at INTEGER,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','ok','failed','skipped','quarantined')),
  error TEXT, chunks INTEGER NOT NULL DEFAULT 0, vectors INTEGER NOT NULL DEFAULT 0);
CREATE INDEX stage_by_file ON ingest_stage_events(file_id, started_at);
CREATE INDEX stage_by_batch ON ingest_stage_events(batch_id, started_at);
CREATE INDEX stage_by_end ON ingest_stage_events(batch_id, stage, ended_at);

CREATE TABLE ingest_batches (                    -- 批次的流水线状态(重启后保持)
  batch_id TEXT PRIMARY KEY, collection TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'running'
    CHECK (state IN ('running','paused','canceled','done')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
