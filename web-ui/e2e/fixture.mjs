// 视觉回归用的**确定性 API fixture**(确定性要求:比较前用 fixture 数据,数值与效果图一致)。
//
// 做法:在 Playwright 里拦截 `/api/v1/**`,返回与设计稿一致的数值。
// 真正的功能正确性由 `e2e/smoke.spec.ts` 打真实守护进程覆盖,这里只负责“画面一致”。
//
// 数值来源:仪表盘设计稿.png(12,438 行 / 1,206 insights / 7 条待审 / 3 个队列任务 /
// 3 个项目 knowledgeBase 4.8k、SampleApp 5.1k、sampleproj 2.5k)。

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { createSocial } from './fixture-social.mjs'
import { adminResponses } from './fixture-admin.mjs'

const ok = (data) => ({ ok: true, data, meta: { took_ms: 1, dry_run: false, batch_id: null, degraded: null, warnings: [] } })

// 设计稿的“现在”是 2026-10-21 00:42 (UTC+8) → UTC 10-20 16:42;截图时浏览器时区固定为 Asia/Shanghai
export const NOW = Date.UTC(2026, 9, 20, 16, 42, 0)
/** 各上下文里被接管的 WebSocket(见 overrides.__live) */
const liveSockets = new WeakMap()
/** 往页面推一帧服务端事件,例如 pushLive(context, {type:'notify', data:{...}}) */
export function pushLive(context, event) {
  for (const ws of liveSockets.get(context) ?? []) ws.send(JSON.stringify(event))
}
/** 北京时间 → 毫秒时间戳(截图时区固定 Asia/Shanghai) */
export const sh = (month, day, hour, minute, second = 0) => Date.UTC(2026, month - 1, day, hour - 8, minute, second)
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export const fixture = {
  // 与仪表盘设计稿的「集合」表逐行一致
  collections: [
    { name: 'knowledgeBase/insights', kind: 'project', project_id: 'p1', rows: 482, items: 60, embedder_id: 'fastembed:bge-m3-int8', dim: 1024, last_indexed_at: NOW },
    { name: 'knowledgeBase/code', kind: 'project', project_id: 'p1', rows: 3114, items: 389, embedder_id: 'fastembed:bge-m3-int8', dim: 1024, last_indexed_at: NOW - 12 * MINUTE },
    { name: 'SampleApp/code', kind: 'project', project_id: 'p2', rows: 4206, items: 525, embedder_id: 'fastembed:bge-m3-int8', dim: 1024, last_indexed_at: NOW - 30 * MINUTE },
    { name: 'SampleApp/docs', kind: 'project', project_id: 'p2', rows: 912, items: 114, embedder_id: 'fastembed:bge-m3-int8', dim: 1024, last_indexed_at: NOW - 3 * MINUTE },
    { name: 'sampleproj/code', kind: 'project', project_id: 'p3', rows: 2488, items: 311, embedder_id: 'fastembed:bge-m3-int8', dim: 1024, last_indexed_at: NOW - 2 * DAY },
    { name: 'sampleproj/docs', kind: 'project', project_id: 'p3', rows: 736, items: 92, embedder_id: 'fastembed:bge-m3-int8', dim: 1024, last_indexed_at: NOW - 2 * DAY },
    { name: 'SampleApp/insights', kind: 'project', project_id: 'p2', rows: 390, items: 48, embedder_id: 'fastembed:bge-m3-int8', dim: 1024, last_indexed_at: NOW - 30 * MINUTE },
  ],
  projects: [
    { project: { id: 'p2', name: 'SampleApp', slug: 'sampleapp', root_path: '/srv/sampleapp', include: ['backend/**', 'frontend/**'], exclude: ['node_modules/**'], is_git: true, last_commit: 'a1b2c3d', last_indexed_at: NOW - 30 * MINUTE, allow_cloud_llm: false, extract_enabled: true, hooks_installed: true, created_at: NOW - 90 * DAY }, collection: 'proj_sampleapp', rows: 5100, items: 637 },
    { project: { id: 'p1', name: 'knowledgeBase', slug: 'knowledgebase', root_path: '/srv/kb', include: ['src/**', 'docs/**'], exclude: ['target/**', 'web-ui/node_modules/**'], is_git: true, last_commit: 'e705205', last_indexed_at: NOW - 12 * MINUTE, allow_cloud_llm: true, extract_enabled: true, hooks_installed: true, created_at: NOW - 40 * DAY }, collection: 'proj_knowledgebase', rows: 4800, items: 600 },
    { project: { id: 'p3', name: 'sampleproj', slug: 'sampleproj', root_path: '/srv/sampleproj', include: ['src/**'], exclude: ['target/**'], is_git: true, last_commit: 'ff00aa1', last_indexed_at: NOW - 2 * DAY, allow_cloud_llm: false, extract_enabled: false, hooks_installed: false, created_at: NOW - 120 * DAY }, collection: 'proj_sampleproj', rows: 2500, items: 312 },
  ],
  // 与仪表盘设计稿的「任务队列」表逐行一致
  jobs: [
    { id: 'j1', kind: 'reindex', collection: 'SampleApp/docs', state: 'running', progress_done: 64, progress_total: 100, rate: 12.4, error: null, created_at: NOW - 3 * MINUTE, started_at: NOW - 2 * MINUTE, finished_at: null },
    { id: 'j2', kind: 'evolve', collection: 'knowledgeBase', state: 'queued', progress_done: 0, progress_total: null, rate: null, error: null, created_at: NOW - 2 * MINUTE, started_at: null, finished_at: null },
    { id: 'j3', kind: 'eval', collection: 'knowledgeBase', state: 'queued', progress_done: 0, progress_total: null, rate: null, error: null, created_at: NOW - 90_000, started_at: null, finished_at: null },
    { id: 'j4', kind: 'ingest', collection: 'sampleproj/code', state: 'done', progress_done: 12, progress_total: 12, rate: 9.1, error: null, created_at: NOW - 10 * MINUTE, started_at: NOW - 9 * MINUTE, finished_at: NOW - 2 * MINUTE },
    { id: 'j5', kind: 'evolve', collection: 'SampleApp', state: 'done', progress_done: 5, progress_total: 5, rate: 2.1, error: null, created_at: NOW - 25 * MINUTE, started_at: NOW - 24 * MINUTE, finished_at: NOW - 18 * MINUTE },
    { id: 'j6', kind: 'embed', collection: 'sampleproj/docs', state: 'failed', progress_done: 3, progress_total: 10, rate: 1.2, error: 'sidecar timeout', created_at: NOW - 30 * MINUTE, started_at: NOW - 29 * MINUTE, finished_at: NOW - 19 * MINUTE },
    { id: 'j7', kind: 'backup', collection: '全部', state: 'done', progress_done: 1, progress_total: 1, rate: 0.4, error: null, created_at: NOW - 70 * MINUTE, started_at: NOW - 69 * MINUTE, finished_at: NOW - 60 * MINUTE },
  ],
  insights: [
    { id: 'ins_7d02', collection: 'proj_sampleapp', kind: 'insight', lang: null, source: 'insight:ins_7d02', start_line: null, end_line: null, symbol: null, title: 'rerank 超时 → 降级为向量序', status: 'active', tags: ['rerank'], updated_at: NOW - 30 * MINUTE, version: 2 },
    { id: 'ins_8f21', collection: 'proj_knowledgebase', kind: 'insight', lang: null, source: 'insight:ins_8f21', start_line: null, end_line: null, symbol: null, title: 'UDS 断线后 CLI 自动降级为直读 SQLite', status: 'active', tags: ['uds', 'degrade'], updated_at: NOW - 1 * MINUTE, version: 3 },
    { id: 'ins_8e07', collection: 'proj_knowledgebase', kind: 'insight', lang: null, source: 'insight:ins_8e07', start_line: null, end_line: null, symbol: null, title: 'kb search 输出 --json 时 stderr 不能混入进度', status: 'active', tags: ['cli'], updated_at: NOW - 9 * MINUTE, version: 1 },
  ],
  code: [
    { id: 'ch_9a1', collection: 'proj_knowledgebase', kind: 'code', lang: 'rust', source: 'crates/kb-cli/src/runtime.rs', start_line: 44, end_line: 78, symbol: 'impl Embedded › fn open', title: null, status: 'active', tags: [], updated_at: NOW - 12 * MINUTE, version: null },
    { id: 'ch_9a2', collection: 'proj_knowledgebase', kind: 'doc', lang: 'markdown', source: 'RELEASE_NOTES.md', start_line: 3, end_line: 3, symbol: null, title: '进度(RELEASE_NOTES.md) › 当前阶段', status: 'active', tags: ['进度'], updated_at: NOW - 40 * MINUTE, version: null },
  ],
}

/** 7 天活跃度(与设计稿的柱状图节奏一致)。 */
const activity = [
  { day: '10-15', values: [6, 9, 3] },
  { day: '10-16', values: [4, 12, 2] },
  { day: '10-17', values: [8, 7, 5] },
  { day: '10-18', values: [3, 15, 1] },
  { day: '10-19', values: [9, 11, 4] },
  { day: '10-20', values: [5, 18, 6] },
  { day: '10-21', values: [7, 14, 3] },
].flatMap((entry) =>
  entry.values.map((insights, index) => ({
    day: `2026-${entry.day}`,
    collection: ['proj_sampleapp', 'proj_knowledgebase', 'proj_sampleproj'][index],
    insights,
  })),
)

const stats = {
  collections: fixture.collections,
  totals: { rows: 12438, items: 1555, insights: 1206, projects: 3 },
  jobs: { queued: 2, running: 1, paused: 0, done: 42, failed: 1, canceled: 0 },
  drafts_pending: 7,
  embedder: { id: 'fastembed:bge-m3-int8', dim: 1024, state: 'ready', error: null },
  reranker: { mode: 'auto', available: true },
  // 趋势类指标(后端待补的可选字段):与仪表盘设计稿的指标卡一致
  trends: {
    rows: { delta: '+312 本周', series: [11.7, 14.3, 11.6, 18.3, 7.4, 7.2, 10.2, 19.1, 12.6, 16.1, 17.5, 24] },
    insights: { delta: '+48 本周' },
    drafts: { stale_24h: 3 },
    search_p95: { ms: 84, delta_ms: -12, series: [13.9, 11.9, 5.4, 13.6, 12.9, 11.4, 18.7, 12.8, 10.7, 7.7, 20.3, 24] },
  },
  recent_events: [
    { id: 'e1', kind: 'insight.promoted', project_id: 'p1', payload_json: '{}', received_at: NOW - 1 * MINUTE, processed_at: NOW - 1 * MINUTE, result: '“UDS 断线后 CLI 自动降级为直读 SQLite”' },
    { id: 'e2', kind: 'draft.created', project_id: 'p1', payload_json: '{}', received_at: NOW - 4 * MINUTE, processed_at: NOW - 4 * MINUTE, result: 'evolve · knowledgeBase · 2 条候选' },
    { id: 'e3', kind: 'draft.skipped', project_id: 'p1', payload_json: '{}', received_at: NOW - 6 * MINUTE, processed_at: NOW - 6 * MINUTE, result: 'skipped_fingerprint × 3' },
    { id: 'e4', kind: 'mcp.session', project_id: null, payload_json: '{}', received_at: NOW - 9 * MINUTE, processed_at: NOW - 9 * MINUTE, result: 'Claude Code · 2025-06-18' },
  ],
  activity_7d: activity,
}

// 与仪表盘设计稿的「最近事件」下半部分一致(前 4 条来自 stats.recent_events,后 5 条是能力调用审计)
const audit = [
  ['search', { query: 'rerank 超时 降级', took_ms: 41 }, 12, true],
  ['reindex.start', { collection: 'SampleApp/docs', embedder: 'bge-m3' }, 20, true],
  ['feedback.useful', { target: 'search#8f21', delta: '+1' }, 23, true],
  ['embed.error', { collection: 'sampleproj/docs', reason: 'sidecar timeout' }, 30, false],
  ['backup.done', { file: 'kb-2026-10-21.tar.zst', size: '182 MB' }, 37, true],
].map(([capability, args, minutes, ok], index) => ({
  id: index + 1,
  at: NOW - minutes * MINUTE,
  actor: 'mcp · Claude Code',
  capability,
  args_json: JSON.stringify(args),
  ok,
  error: null,
  batch_id: null,
  dry_run: false,
}))

const batches = [
  { id: 'bat_1002', actor: 'user', description: 'edit_item 调用', created_at: NOW - 6 * MINUTE, reverted_at: null, changes: [{ seq: 1, target: 'ins_8f21', op: 'insight.update', revertible: true }] },
  { id: 'bat_1000', actor: 'user', description: 'batch_tag 调用', created_at: NOW - 12 * MINUTE, reverted_at: null, changes: [{ seq: 1, target: 'ch_9a1', op: 'item.tags', revertible: true }, { seq: 2, target: 'ch_9a2', op: 'item.tags', revertible: true }] },
]

const config = {
  server: { listen: '127.0.0.1:7070', allow_remote: false },
  embed: { backend: 'fastembed', model: 'bge-m3-int8', max_tokens: 512, batch_size: 8, preload: true, threads: 0, idle_unload_minutes: 0, compat_group: 'bge-m3', http: { base_url: 'http://127.0.0.1:18081', model: 'bge-m3' } },
  search: { k: 10, global_weight: 0.8, rrf_k: 60, window_context_lines: 8, mcp_max_output_chars: 24000 },
  index: { watch: true, debounce_ms: 2000, max_file_bytes: 1048576, exclude: ['target/**', 'node_modules/**'] },
  mcp: { transports: ['stdio', 'http'], allowed_hosts: [] },
  meta: { read_pool: 4 },
  schedule: { nightly_at: '03:00', optimize_interval_minutes: 60 },
  // 定时备份与保留策略(设置页「备份」分区的表单)
  backup: {
    enabled: true,
    interval_hours: 24,
    keep_count: 7,
    keep_days: 0,
    include_sources: false,
    mirror_dirs: ['/mnt/usb/kb-backups', '/mnt/nas/kb-offsite'],
  },
  llm: { provider: 'deepseek', base_url: 'https://api.deepseek.com', extract_model: 'deepseek-chat', review_model: 'deepseek-reasoner', agent_model: 'deepseek-chat', daily_token_budget: 2000000, max_calls_per_hour: 120 },
  rerank: { mode: 'auto' },
  accel: { enabled: false },
  evolution: { review_mode: 'ai_then_human', approve_threshold: 0.72, dedup_similarity: 0.88, extract_enabled_default: true },
  log: { level: 'info', json: false },
  network: { proxy: '' },
  paths: {},
}

const tokens = [
  { id: 'kbt_3f9a', name: 'kiro-demo', scopes: 'mcp:read mcp:write', created_at: NOW - 30 * DAY, last_used: sh(10, 21, 0, 33), revoked_at: null },
  { id: 'kbt_a81c', name: 'claude-code', scopes: 'mcp:read mcp:write', created_at: NOW - 30 * DAY, last_used: sh(10, 21, 0, 33), revoked_at: null },
  { id: 'kbt_02de', name: 'codex-ro', scopes: 'mcp:read', created_at: NOW - 20 * DAY, last_used: sh(10, 20, 22, 14), revoked_at: null },
  { id: 'kbt_7b41', name: 'ci-eval', scopes: 'api:eval', created_at: NOW - 10 * DAY, last_used: sh(10, 20, 3, 0), revoked_at: null },
  { id: 'kbt_c90e', name: 'dev-laptop', scopes: 'admin', created_at: NOW - 5 * DAY, last_used: sh(10, 19, 18, 27), revoked_at: null },
]

const evalResult = {
  hit_at_1: 0.9,
  hit_at_k: 1.0,
  k: 5,
  mrr: 0.927,
  cases: [
    { query: '双哈希增量索引', rank: 1, top: 'docs/ARCHITECTURE.md:14.1' },
    { query: 'UDS 套接字通信', rank: 1, top: 'crates/kb-web/src/router.rs:53' },
    { query: 'rerank 降级', rank: 2, top: 'crates/kb-service/src/search/mod.rs:120' },
    { query: '迁移断点续跑', rank: null, top: null },
  ],
}

/** `eval_history` 的形状与 `<KB_HOME>/eval/history.jsonl` 一行一条一致(新的在前)。 */
const evalRuns = [
  // hit@1 ≤ hit@3 ≤ hit@k ≤ hit@10 必须成立;mode 只会是 fts / hybrid / hybrid+rerank
  { at: NOW - 2 * HOUR, run_id: 'ev_0k7x2a', mode: 'hybrid+rerank', hit_at_1: 0.9, hit_at_3: 0.94, hit_at_k: 0.96, hit_at_10: 0.98, k: 5, mrr: 0.927, p95_ms: 212, degraded_cases: 0, reranked_cases: 50 },
  { at: NOW - DAY, run_id: 'ev_0k6t91', mode: 'hybrid', hit_at_1: 0.85, hit_at_3: 0.9, hit_at_k: 0.95, hit_at_10: 0.97, k: 5, mrr: 0.894, p95_ms: 208, degraded_cases: 1, reranked_cases: 49 },
  { at: NOW - 2 * DAY, run_id: 'ev_0k5p04', mode: 'hybrid', hit_at_1: 0.8, hit_at_3: 0.84, hit_at_k: 0.9, hit_at_10: 0.94, k: 5, mrr: 0.861, p95_ms: 34, degraded_cases: 0, reranked_cases: 0 },
  { at: NOW - 3 * DAY, run_id: 'ev_0k4m77', mode: 'fts', hit_at_1: 0.62, hit_at_3: 0.7, hit_at_k: 0.78, hit_at_10: 0.85, k: 5, mrr: 0.72, p95_ms: 19, degraded_cases: 50, reranked_cases: 0 },
]

const searchHits = [
  { id: 'ins_8f21', collection: 'knowledgeBase/insights', kind: 'insight', source: 'insight:ins_8f21', start_line: null, end_line: null, symbol: null, title: 'UDS 断线后 CLI 自动降级为直读 SQLite', snippet: '… 连接 kbd.sock 失败 → 回退为只读直连 SQLite，跳过 rerank …', score: 0.961, related: [], explain: { store_rank: 1, fused_rank: 1, fused_score: 0.0164, fused_weight: 1, fts_rank: 4, fts_score: 12.31, vector_rank: 1, vector_score: 0.842, rerank_rank: 1, window: null } },
  { id: 'code_3a9e', collection: 'knowledgeBase/code', kind: 'code', source: 'kb-cli/src/client.rs', start_line: 88, end_line: 96, symbol: 'fn search_with_fallback(&self, q: &Query)', title: null, snippet: 'if let Err(e) = uds.connect() { warn!("degraded"); return self.direct_sqlite(q) }', score: 0.912, related: [], explain: { store_rank: 3, fused_rank: 2, fused_score: 0.0159, fused_weight: 1, fts_rank: 1, fts_score: 15.02, vector_rank: 3, vector_score: 0.801, rerank_rank: 2, window: null } },
  { id: 'ins_7d02', collection: 'knowledgeBase/insights', kind: 'insight', source: 'insight:ins_7d02', start_line: null, end_line: null, symbol: null, title: 'rerank 超时 300ms → 降级为向量序', snippet: 'sidecar 无响应时 rerank 阶段直接返回 RRF 顺序 …', score: 0.874, related: [], explain: { store_rank: 5, fused_rank: 3, fused_score: 0.0154, fused_weight: 1, fts_rank: 2, fts_score: 13.77, vector_rank: 5, vector_score: 0.779, rerank_rank: 3, window: null } },
  { id: 'ins_6f30', collection: 'knowledgeBase/insights', kind: 'insight', source: 'insight:ins_6f30', start_line: null, end_line: null, symbol: null, title: 'MCP stdio 下日志禁止写 stdout', snippet: '协商信息写入日志文件，否则会破坏 JSON-RPC 帧 …', score: 0.655, related: [], explain: { store_rank: 4, fused_rank: 5, fused_score: 0.0156, fused_weight: 1, fts_rank: 9, fts_score: 8.12, vector_rank: 4, vector_score: 0.788, rerank_rank: 5, window: null } },
]

/** 与设计稿底栏 / 侧栏一致:uptime 3d 4h · demo-host · 磁盘 /srv/kb 78% · MCP 会话 2 */
const systemStatus = {
  overview: { service: { version: '0.4.0', uptime_seconds: 3 * 86400 + 4 * 3600 + 600, home: '/srv/kb', listen: '127.0.0.1:7070', host: 'demo-host' }, collections: 7, projects: 3, sources: 2, pending_drafts: 7, components_ready: [4, 4], note: null },
  resources: { cpu: { cores: 8, busy_ratio: 0.21, load: [0.8, 0.7, 0.6] }, memory: { total_mb: 32768, available_mb: 18000, used_ratio: 0.45 }, disk: { mount: '/srv', free_gb: 22, total_gb: 100, used_ratio: 0.78 }, gpu: { name: 'Intel Iris Xe', utilization: 0.38, memory_used_mb: null, note: null } },
  network: { listen: '127.0.0.1:7070', socket: '~/.kb/kbd.sock', allow_remote: false, mcp_transports: ['stdio', 'http'], mcp_allowed_hosts: [], mcp_sessions: 2, llm_calls_today: 18, llm_tokens_today: [182000, 41000], llm_sends_today: 18 },
  env: { cpu_cores: 8, memory_mb: 32768, disk_free_gb: 22, has_nvidia: false, gpu: 'Intel Iris Xe', has_intel_gpu: true, tools: ['git', 'python3', 'node'] },
  jobs: { by_state: [['done', 42], ['queued', 2], ['running', 1], ['failed', 1]], recent: [], ingest: [] },
  logs: { dir: '~/.kb/logs', files: [], tail: [], diagnostics: [] },
  components: [
    { kind: 'embed', id: 'bge-m3', name: 'bge-m3 · ONNX', installed: true, ready: true, current: true, detail: 'iGPU', model: null },
    { kind: 'rerank', id: 'bge-reranker-v2-m3', name: 'bge-reranker-v2-m3', installed: true, ready: true, current: true, detail: 'iGPU', model: null },
    { kind: 'llm', id: 'deepseek-chat', name: 'deepseek-chat', installed: true, ready: true, current: true, detail: 'API', model: null },
    { kind: 'sidecar', id: 'onnx-sidecar', name: 'onnx-sidecar :7071', installed: true, ready: true, current: true, detail: 'pid 4182', model: null },
    // 本地审核模型按需加载:就绪(可加载)但当前没加载,不是故障
    { kind: 'review', id: 'qwen2.5-14b', name: 'qwen2.5-14b (本地)', installed: true, ready: true, current: true, detail: '未加载', model: null },
  ],
}

const sources = [
  { id: 'src_1', kind: 'local_dir', name: 'knowledgeBase 文档', uri: '/srv/kb/docs', collection: 'knowledgeBase/docs', tags: ['docs'], include: ['**/*.md'], exclude: [], depth: 0, allow_hosts: [], refresh_minutes: 60, status: 'idle', last_synced_at: NOW - 12 * MINUTE, last_error: null, files: 214, created_at: NOW - 20 * DAY },
  { id: 'src_2', kind: 'git', name: 'SampleApp 仓库', uri: 'git@example.com:sampleapp.git', collection: 'SampleApp/code', tags: [], include: [], exclude: [], depth: 0, allow_hosts: [], refresh_minutes: null, status: 'idle', last_synced_at: NOW - 30 * MINUTE, last_error: null, files: 4206, created_at: NOW - 40 * DAY },
]

/** 能力名 → 返回体。 */
const responses = {
  system_status: systemStatus,
  list_sources: { sources },
  list_ingest: { files: [], total: 0 },
  provider_list: { providers: [], env: systemStatus.env },
  // 设置页 LLM 提供商表(设计稿:DeepSeek 已设置 / OpenAI、Anthropic 未设置 / 本地 Ollama 已连接)
  llm_providers: {
    current: 'deepseek',
    secret_present: true,
    models: { extract: 'deepseek-chat', review: 'deepseek-reasoner', agent: 'deepseek-reasoner' },
    providers: [
      { id: 'deepseek', name: 'DeepSeek', env_var: 'DEEPSEEK_API_KEY', base_url: 'https://api.deepseek.com', configured: true, current: true, model: 'deepseek-chat', note: null, supported: true },
      { id: 'openai', name: 'OpenAI', env_var: 'OPENAI_API_KEY', base_url: 'https://api.openai.com/v1', configured: false, current: false, model: null, note: null, supported: true },
      { id: 'anthropic', name: 'Anthropic', env_var: 'ANTHROPIC_API_KEY', base_url: 'https://api.anthropic.com', configured: false, current: false, model: null, note: 'Anthropic 不是 OpenAI 兼容接口,本版本不支持直连', supported: false },
      { id: 'ollama', name: '本地 Ollama', env_var: null, base_url: 'http://127.0.0.1:11434', configured: false, current: false, model: null, note: '本机模型,不需要密钥', supported: true },
    ],
  },
  // 设置页「检索调权」:一条建议 + 一个被跳过的原因
  tune_retrieval: {
    feedback: 128,
    matched: 121,
    overall_rate: 0.71,
    groups: [
      { collection: 'proj_sampleapp', kind: 'doc', prefix: 'docs', total: 42, useful: 37, rate: 0.881 },
      { collection: 'proj_sampleapp', kind: 'code', prefix: 'backend', total: 26, useful: 15, rate: 0.577 },
      { collection: 'proj_sampleproj', kind: 'doc', prefix: 'notes', total: 18, useful: 12, rate: 0.667 },
    ],
    suggestions: [
      {
        collection: 'proj_sampleapp',
        current: 1,
        suggested: 1.2,
        delta: 0.2,
        samples: 42,
        useful_rate: 0.881,
        reason: '有用率 88% 比全局高 17 个百分点,权重上调 0.20',
      },
      {
        collection: 'proj_sampleproj',
        current: 1,
        suggested: 0.95,
        delta: -0.05,
        samples: 18,
        useful_rate: 0.667,
        reason: '有用率接近全局均值,权重小幅下调 0.05',
      },
    ],
    skipped: ['proj_demo 只有 3 条反馈,样本不足(需要 ≥ 5)'],
  },
  // 设置页「Skills」:两个已启用的声明式 skill
  list_skills: {
    dir: '/home/user/.kb/skills',
    allow_exec: false,
    skills: [
      {
        id: 'proto',
        name: 'proto',
        manifest: '/home/user/.kb/skills/proto/manifest.toml',
        kind: 'loader-rule',
        enabled: true,
        rules: ['**/*.proto → text +proto,schema'],
        prompt_stages: [],
        template_required: [],
      },
      {
        id: 'strict-review',
        name: 'strict-review',
        manifest: '/home/user/.kb/skills/strict-review/manifest.toml',
        kind: 'prompt',
        enabled: true,
        rules: [],
        prompt_stages: ['review'],
        template_required: [],
      },
      {
        name: 'legacy-notes',
        manifest: '/home/user/.kb/skills/legacy-notes/manifest.toml',
        kind: 'insight-template',
        enabled: false,
        rules: [],
        prompt_stages: [],
        template_required: ['body', 'tags'],
      },
    ],
    warnings: ['skill legacy-notes 已停用,跳过'],
  },
  // 审核收件箱(收尾阶段):两条待审 + 各状态计数
  list_drafts: {
    total: 2,
    counts: { pending: 2, approved: 11, rejected: 3, duplicate: 4 },
    drafts: [
      {
        id: 'drf_7c21',
        collection: 'proj_sampleapp',
        project: 'SampleApp',
        title: 'sidecar 超时后按指数退避重试,再降级到 CPU',
        body_md:
          '调用 onnx-sidecar 超时后,按 200ms → 400ms → 800ms 指数退避重试三次;仍失败则降级到 CPU 推理,并在结果里标注 degraded。',
        kind: 'decision',
        tags: ['sidecar', '重试'],
        related_paths: ['backend/inference/sidecar.rs'],
        evidence: ['+ let delay = base_delay * 2u64.pow(attempt);'],
        state: 'pending',
        score: 0.86,
        decision: 'approve',
        reasons: ['具体且与证据一致', '长期有效', '与已有条目不同'],
        duplicate_of: null,
        insight_id: null,
        created_at: NOW - 40 * 60 * 1000,
        decided_at: null,
      },
      {
        id: 'drf_7c1e',
        collection: 'proj_sampleapp',
        project: 'SampleApp',
        title: '索引任务不要在持有写锁时调用嵌入器',
        body_md: '嵌入是异步外呼,持锁期间等待会让迁移的写闸门一直拿不到锁;先取向量再进临界区。',
        kind: 'pitfall',
        tags: ['锁', '索引'],
        related_paths: ['backend/index/worker.rs'],
        evidence: ['- let guard = state.write().await;'],
        state: 'pending',
        score: 0.72,
        decision: 'revise',
        reasons: ['结论成立但表述偏笼统'],
        duplicate_of: null,
        insight_id: null,
        created_at: NOW - 3 * 60 * 60 * 1000,
        decided_at: null,
      },
    ],
  },
  // 设置页「备份」分区(无设计稿,按后端 backup_status 的真实形状给数据)
  backup_status: {
    home: '/home/user/.kb',
    dir: '/home/user/.kb/backups',
    last_backup_at: NOW - 26 * 60 * 60 * 1000,
    // 定时备份与保留策略(与 `[backup]` 默认值一致)
    policy: {
      enabled: true,
      interval_hours: 24,
      keep_count: 7,
      keep_days: 0,
      include_sources: false,
      mirror_dirs: ['/mnt/usb/kb-backups', '/mnt/nas/kb-offsite'],
    },
    next_backup_at: NOW + 22 * 60 * 60 * 1000,
    // 上次自动备份的结果(设置页据此显示成功 / 失败)
    last_auto: { at: NOW - 26 * 60 * 60 * 1000, ok: true, error: null },
    // 正常状态:没有在打包、没有未解决的失败
    progress: null,
    alert: null,
    failures: [],
    // 异地副本:一个同步到位、一个外接盘没挂上(长错误文案是最容易撑破版式的那种)
    mirrors: [
      {
        dir: '/mnt/usb/kb-backups',
        last_ok_at: NOW - 26 * 60 * 60 * 1000,
        last_error: null,
        error_at: 0,
        copies: 3,
        has_latest: true,
      },
      {
        dir: '/mnt/nas/kb-offsite',
        last_ok_at: NOW - 50 * 60 * 60 * 1000,
        last_error: '建目录 /mnt/nas/kb-offsite 失败: No such file or directory',
        error_at: NOW - 26 * 60 * 60 * 1000,
        copies: 1,
        has_latest: false,
      },
    ],
    // 最近一次自动校验(备份写完后服务端自己跑的那次)
    last_check: {
      at: NOW - 26 * 60 * 60 * 1000,
      name: 'kb-20251020-004200.tar.gz',
      ok: true,
      error: null,
      files: 12,
      uncompressed_bytes: 15_728_640,
      meta_db_bytes: 12_582_912,
    },
    usage: {
      meta_db_bytes: 12_582_912,
      lance_bytes: 1_073_741_824,
      sources_bytes: 268_435_456,
      uploads_bytes: 0,
      skills_bytes: 4096,
      eval_bytes: 131_072,
      config_bytes: 3072,
      backups_bytes: 18_874_368,
    },
    entries: [
      { name: 'kb-20251020-004200.tar.gz', size_bytes: 14_680_064, created_at: NOW - 26 * 60 * 60 * 1000, includes_sources: false },
      { name: 'kb-20251018-213015.tar.gz', size_bytes: 4_194_304, created_at: NOW - 74 * 60 * 60 * 1000, includes_sources: true },
    ],
    notes: [
      '备份内容:元数据库、config.toml、skills、评测数据;原件(sources)可选',
      '不备份:向量表与模型(重建索引可恢复)、secrets.toml(含 API key)',
      '恢复方式:停守护进程 → 把归档解到 KB_HOME → 启动 → 按需重建索引',
    ],
  },
  // 备份的轻量状态(外壳横幅每次挂载问一次;正常状态没有失败告警)
  backup_state: { running: null, alert: null, failures: [], last_success_at: NOW - 26 * 60 * 60 * 1000 },
  recommend_providers: { recommendations: [] },
  ocr_status: { installed: false, install: { state: 'idle', lines: 0, tail: [], error: null, command: '' } },
  stats_overview: stats,
  list_projects: { projects: fixture.projects },
  // 浏览器左栏的集合树(设计稿):与仪表盘的集合表是两份不同的清单
  list_collections: {
    collections: [
      ['knowledgeBase/insights', 482],
      ['knowledgeBase/code', 3114],
      ['knowledgeBase/docs', 214],
      ['SampleApp/insights', 390],
      ['SampleApp/code', 4206],
      ['sampleproj/code', 2488],
    // items = 可浏览的条目数(文件 + 笔记),CollectionStats 的必填字段:树里每个集合后面的数字、集合选择器括号里的数都读它;
    // 夹具只给 rows(块数)时页面会把 compact(undefined) 画成字面的「undefined」。块数约是条目数的 8 倍
    ].map(([name, rows]) => ({ name, kind: 'project', project_id: 'p1', embedder_id: 'fastembed:bge-m3-int8', dim: 1024, active_table: name, rows, items: Math.max(1, Math.round(rows / 8)), migrating_to: null })),
  },
  job_list: { jobs: fixture.jobs },
  job_get: { job: fixture.jobs[0] },
  // 任务详情按文件列出改动(3080c96b):没有这个能力时页面拿到空对象,`[...found.items]` 会抛 TypeError。
  // 按接口注释返回「老任务」的空清单,页面回退到任务参数里的路径清单
  job_files: { job_id: 'j2', total: 0, page: 1, page_size: 200, counts: {}, items: [] },
  // 向量表体检(7b1e617f,能力 index_stats):系统状态页的「向量表」面板读它,缺这个能力时页面拿到空对象,`data.tables.length` 抛 TypeError。
  // 形状同 utils/indexStats.ts 的 IndexStats:三张表,一张碎片多、一张行数过了阈值却没有索引,让两种提示都能画出来
  index_stats: {
    threshold: 10000,
    tables: [
      { table: 'chunks_knowledgebase_insights', collection: 'knowledgeBase/insights', rows: 482, fragments: 3, data_files: 3, version: 41, versions: 6, index_kind: null, index_rows: null, index_unindexed_rows: null, index_created_at: null, missing_vector_index: false },
      { table: 'chunks_knowledgebase_code', collection: 'knowledgeBase/code', rows: 3114, fragments: 260, data_files: 260, version: 912, versions: 40, index_kind: null, index_rows: null, index_unindexed_rows: null, index_created_at: null, missing_vector_index: false },
      { table: 'chunks_sampleapp_code', collection: 'SampleApp/code', rows: 42060, fragments: 12, data_files: 12, version: 88, versions: 9, index_kind: 'ivf_hnsw_sq', index_rows: 41000, index_unindexed_rows: 1060, index_created_at: 1_792_000_000_000, missing_vector_index: false },
    ],
  },
  job_cancel: { job_id: 'j2', state: 'canceled' },
  audit_list: { entries: audit, total: 128, page_size: 20, offset: 0 },
  batch_list: { batches, total: 9, page_size: 20, offset: 0 },
  // list_items / get_item / item_history 按请求参数返回(见 dynamicResponses)
  search_knowledge: {
    hits: searchHits,
    scope: ['knowledgeBase', '_global'],
    query_parsed: { text: 'uds 断开 降级 rerank', filters: { project: 'knowledgeBase', status: 'active' } },
    degraded: null,
    // 设计稿的 Explain 面板写着 141 ms;这里给一组与它同量级的阶段耗时
    timings: { parse_ms: 0.3, embed_ms: 8.4, store_ms: 12.1, fts_ms: 3.8, vector_ms: 11.6, fuse_ms: 0.2, rerank_ms: 24.9, total_ms: 41.0 },
  },
  get_config: {
    ...config,
    ai: { enabled: true, extract: true, deep_search: true, organize: true, assistant: true, acp: true, chunk_context: false },
    accounts: { registration_open: true, require_admin_totp: false, require_invite: false, default_role: 'role_user', username_required: true, deletion_cooling_off_days: 7, invites_per_user: 0, block_disposable_email: true, email_domain_allowlist: [] },
    quota: { storage_gb: 100, max_upload_mb: 200, llm_tokens_per_day: 200000, acp_concurrency_total: 8, acp_concurrency_per_user: 1, acp_minutes: 30, disk_reserve_gb: 30, links_per_user: 1000, friends_per_user: 1000 },
    share: { allow_guest_view: true, allow_guest_comment: false, allow_guest_edit: false, guest_link_gb_per_day: 10, room_max_users: 30 },
    // timezone:b9f15e4f 起站点时区是必填参数,真实后端总会给默认值;夹具缺它时系统参数页的保存条会一直报「时区不能为空」而禁用保存
    site: { name: 'knowledgeBase', tagline: '个人与团队的知识库', public_url: 'https://kb.example.com', timezone: 'Asia/Shanghai' },
    // 与 crates/kb-core/src/config/mod.rs 的默认值一致:系统参数页的字段表里有这几个键,缺了会被当成「空 = 不合法」
    index: { ...config.index, parallel_slices: 0 },
    network: { ...config.network, hf_cdn_direct: true, crawl_allow_private: false },
  },
  create_token: { id: 'tok_new', name: 'ui', scope: 'mcp', token: 'kb_ui_fixture', created_at: NOW },
  revoke_token: { id: 'tok_2', revoked_at: NOW },
  update_config: { applied: true, restart_required: true, changed: ['search'], config, migration_plan: null, notes: ['配置已写入;重启 `kb daemon` 后生效'] },
  backup_prune: { removed: ['kb-20251018-213015.tar.gz'], failed: [], kept: 1, dry_run: false },
  migrate_plan: { collection: 'proj_sampleapp', from_table: 'proj_sampleapp__bge_m3_int8__v1', to_table: 'proj_sampleapp__bge_m3_int8__v2', from_embedder: 'fastembed:bge-m3-int8', to_embedder: 'fastembed:bge-m3-int8', rows: 5100, insight_rows: 390, estimated_seconds: 96, can_switch_without_reembed: true },
  migrate_model: { job_id: 'j_migrate', collection: 'proj_sampleapp', to: 'fastembed:bge-m3-int8' },
  eval_run: evalResult,
  eval_history: { runs: evalRuns },
  kb_feedback: { id: 1 },
  edit_item: { id: 'ins_8f21', version: 4, collection: 'proj_knowledgebase', job_id: 'j_edit' },
  create_item: { id: 'ins_new', version: 1, collection: 'proj_knowledgebase', job_id: 'j_new' },
  delete_item: { id: 'ins_new', collection: 'proj_knowledgebase', insight: true },
  batch_tag: { updated: [] },
  revert_batch: { batch_id: 'bat_1000', reverted: [{ target: 'ch_9a1', op: 'item.tags' }], skipped: [], at: NOW },
  add_project: { job_id: 'j_add', project: 'demo' },
  reindex_project: { job_id: 'j_reindex' },
  install_hooks: { hooks_dir: '/srv/kb/.git/hooks', managed_by_other: false, hooks: [] },
  uninstall_hooks: { hooks_dir: '/srv/kb/.git/hooks', managed_by_other: false, hooks: [] },
  delete_collection: { deleted: 'proj_sampleproj' },
}


const commonTags = ['uds', 'rerank', 'mcp', 'degrade', 'sqlite', 'eval']

// 与浏览器编辑器设计稿 列表逐行一致(id / 标题 / 类型 / 置信 / 更新)
const browserRows = [
  ['ins_8f21', 'UDS 断线后 CLI 自动降级为直读 SQLite', 'pitfall', 0.94, NOW - MINUTE, 'active'],
  ['ins_8e07', 'kb search 输出 --json 时 stderr 不能混入进度条', 'pitfall', 0.88, sh(10, 20, 22, 10), 'active'],
  ['ins_8c55', 'clap 子命令别名与 MCP 工具名需一一对应', 'decision', 0.91, sh(10, 19, 15, 0), 'active'],
  ['ins_8b10', '--collection 未指定时按 cwd 推断项目', 'pattern', 0.82, sh(10, 19, 11, 0), 'active'],
  ['ins_8a93', 'Windows 下 UDS 路径改用命名管道', 'pitfall', 0.77, sh(10, 18, 16, 0), 'superseded'],
  ['ins_8a41', '错误码统一 kb::Error → exit code 映射表', 'decision', 0.9, sh(10, 18, 10, 0), 'active'],
  ['ins_89f0', '长输出自动走 pager，CI 环境禁用', 'howto', 0.73, sh(10, 17, 18, 0), 'active'],
  ['ins_89c2', '进度条用 indicatif，TTY 检测失败时静默', 'pattern', 0.69, sh(10, 16, 18, 0), 'active'],
  ['ins_8977', 'kb ask 的 token 预算按模型上下文 1/4', 'decision', 0.86, sh(10, 16, 9, 0), 'active'],
  ['ins_8901', '测试中用 tempdir 隔离 ~/.kb', 'howto', 0.8, sh(10, 15, 20, 0), 'active'],
  ['ins_88e4', '配置文件热加载只对 search 段生效', 'pitfall', 0.71, sh(10, 14, 20, 0), 'active'],
  ['ins_88a0', 'fmt/clippy 作为 gate 前置检查', 'pattern', 0.95, sh(10, 13, 9, 0), 'active'],
].map(([id, title, insightKind, confidence, updated, status], index) => ({
  id, collection: 'knowledgeBase/insights', kind: 'insight', insight_kind: insightKind, confidence, lang: null, source: `insight:${id}`,
  start_line: null, end_line: null, symbol: null, title, status, tags: commonTags.slice(0, Math.max(0, 6 - index)).filter((_, tagIndex) => tagIndex <= 5 - Math.floor(index / 2)), updated_at: updated, version: 3,
}))

const browserBody = `## 现象
守护进程重启期间，\`kb search\` 连接 \`~/.kb/kbd.sock\` 失败直接退出 (exit 3)。

## 做法
- 连接失败 → 回退为**只读直连 SQLite**，跳过 rerank
- stderr 提示 \`degraded: uds unavailable\`
- 写操作仍然报错，避免双写

## 关联
[[ins_8b10]] · src/kb-cli/src/client.rs#L88`

/* ---------------- 文件预览的夹具:id → 条目 + file_preview ---------------- */
const pageAnchor = (page) => ({ kind: 'page', page })
const blk = (kind, text, anchor) => ({ kind, text, anchor })
const chunk = (id, ordinal, anchor, text, title = null) => ({ id, ordinal, anchor, start_line: null, end_line: null, title, text })
export const fileItem = (id, source, tags) => ({
  id, collection: 'knowledgeBase/insights', kind: 'doc', insight_kind: null, confidence: null, lang: null, source,
  start_line: null, end_line: null, symbol: null, title: source, status: 'active', tags, updated_at: sh(10, 21, 0, 41),
  text: '', header: source, origin: null, embedded_at: sh(10, 21, 0, 41),
})
const slideAnchor = (slide) => ({ kind: 'slide', slide })
const sheetAnchor = (sheet, cell) => ({ kind: 'cell', sheet, cell })
const timeAnchor = (start, end) => ({ kind: 'time', start_ms: start * 1000, end_ms: end * 1000 })
const mmss = (m, s) => m * 60 + s

const pdfText = '倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。'
export const FILES = {
  file_pdf: {
    item: fileItem('file_pdf', '向量检索综述-2025.pdf', ['论文', 'rrf']),
    preview: {
      format: 'pdf', editable: false, extractor: 'application/pdf',
      blocks: [
        ...[5, 6].map((page) => blk('paragraph', `第 ${page} 页:向量检索的基本假设与评测集构造。`, pageAnchor(page))),
        blk('heading', '3.2 混合检索与倒数排名融合', pageAnchor(7)),
        blk('paragraph', '稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。', pageAnchor(7)),
        blk('paragraph', `${pdfText}重排阶段再以交叉编码器对前 20 条精排。`, pageAnchor(7)),
        blk('table', 'k | 20 | 60 | 100\nnDCG | 0.412 | 0.438 | 0.431', pageAnchor(7)),
        blk('paragraph', '重排阶段以交叉编码器对前 20 条精排，超时回退。', pageAnchor(8)),
        blk('paragraph', '参考文献。', pageAnchor(42)),
      ],
      chunks: [
        chunk('ck_p7_3', 3, pageAnchor(7), pdfText),
        chunk('ck_p7_t', 4, pageAnchor(7), '表 3 · 不同 k 值下的 nDCG@10 | k | 20 | 60 | 100 ...'),
        chunk('ck_p8_1', 5, pageAnchor(8), '重排阶段以交叉编码器对前 20 条精排，超时回退...'),
      ],
    },
  },
  file_xlsx: {
    item: fileItem('file_xlsx', '模型评测-合并单元格.xlsx', ['评测']),
    preview: {
      format: 'xlsx', editable: false, extractor: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      blocks: [
        blk('table', '模型 | 维度 | nDCG@10 | 延迟 ms | 备注\nbge-m3 fp32 | 1024 | 0.438 | 36 | 基线\nbge-m3 INT8 | 1024 | 0.437 | 15 | 默认\nbge-m3 Q8_0 · iGPU | 1024 | 0.436 | 8 | Vulkan\ne5-large | 1024 | 0.401 | 31 | \ntext2vec-base | 768 | 0.352 | 9 | \njina-v3 | 1024 | 0.429 | 28 | 需联网\n合并单元格 · 平均 |  | 0.415 | 21 | ', sheetAnchor('评测汇总', 'A1:E8')),
        blk('table', 'query | hit@3\n混合检索 k 值 | 1', sheetAnchor('原始数据', 'A1:B2')),
        blk('paragraph', '图表占位。', sheetAnchor('图表', 'A1')),
        blk('paragraph', '评测说明。', sheetAnchor('说明', 'A1')),
      ],
      chunks: [
        chunk('ck_s_r2', 1, sheetAnchor('评测汇总', 'R2'), '模型=bge-m3 INT8; 维度=1024; nDCG@10=0.437; 延迟 ms=15; 备注=默认'),
        chunk('ck_s_r7', 2, sheetAnchor('评测汇总', 'R7'), '合并单元格 · 平均 nDCG=0.415 延迟=21'),
        chunk('ck_s_r118', 3, sheetAnchor('原始数据', 'R118'), 'query=混合检索 k 值 ... hit@3=1'),
      ],
    },
  },
  file_pptx: {
    item: fileItem('file_pptx', '产品路线图 Q4.pptx', ['路线图']),
    preview: {
      format: 'pptx', editable: false, extractor: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      blocks: [
        ...[1, 2].map((slide) => blk('heading', `第 ${slide} 张 · 概述`, slideAnchor(slide))),
        blk('heading', '多格式解析与编辑', slideAnchor(3)),
        blk('paragraph', '批次 1 · PDF / Office / HTML / 邮件', slideAnchor(3)),
        blk('paragraph', '批次 2 · OCR / 音视频转写', slideAnchor(3)),
        blk('paragraph', '批次 3 · Notebook / 导出包', slideAnchor(3)),
        blk('paragraph', '备注:先讲批次 1 的收益:覆盖 90% 的日常资料;OCR 和转写全部本地运行,不外发。', slideAnchor(3)),
        blk('heading', '里程碑 第三季度', slideAnchor(4)),
        blk('heading', '收尾', slideAnchor(5)),
        blk('heading', '附录', slideAnchor(26)),
      ],
      chunks: [
        chunk('ck_sl3', 1, slideAnchor(3), '多格式解析与编辑 · 批次 1 PDF Office HTML 邮件 ...'),
        chunk('ck_sl3n', 2, slideAnchor(3), '先讲批次 1 的收益：覆盖 90% 的日常资料...'),
        chunk('ck_sl4', 3, slideAnchor(4), '里程碑 · Kiro 质量检查 ...'),
      ],
    },
  },
  file_png: {
    item: fileItem('file_png', '白板-架构草图.png', ['白板']),
    preview: {
      format: 'png', editable: false, extractor: 'image/*',
      blocks: [
        blk('paragraph', 'kb daemon → LanceDB 向量', null),
        blk('paragraph', 'Extractor 插件', null),
        blk('paragraph', '├ pdf / docx / xlsx / pptx\n└ ocr / whisper', null),
        blk('paragraph', '备注: 统一中间文档 → 复用分块', null),
      ],
      chunks: [
        chunk('ck_i3', 3, null, 'Extractor 插件 ├ pdf / docx / xlsx / pptx └ ocr / whisper'),
        chunk('ck_i1', 1, null, 'kb daemon → LanceDB 向量'),
      ],
    },
  },
  file_m4a: {
    item: fileItem('file_m4a', '周会录音-10-20.m4a', ['周会']),
    preview: {
      format: 'm4a', editable: false, extractor: 'audio|video/*',
      blocks: [
        blk('paragraph', 'RRF 的 k 我们先固定 60，后面用评测集调。', timeAnchor(mmss(31, 2), mmss(31, 15))),
        blk('paragraph', '好的，同时我会把重排超时降级写进设计说明。', timeAnchor(mmss(31, 15), mmss(31, 40))),
        blk('paragraph', '音视频转写必须本地跑 whisper.cpp，不要外发。', timeAnchor(mmss(31, 40), mmss(32, 5))),
        blk('paragraph', '质量检查会检查时间戳能否跳回原音频位置。', timeAnchor(mmss(32, 5), mmss(32, 31))),
        blk('paragraph', '第三季度之前把黄金集补上：中文 PDF、合并单元格 Excel、扫描件。', timeAnchor(mmss(32, 31), mmss(33, 0))),
      ],
      chunks: [
        chunk('ck_a1', 1, timeAnchor(mmss(31, 40), mmss(32, 40)), '音视频转写必须本地跑 whisper.cpp，不要外发...'),
        chunk('ck_a2', 2, timeAnchor(mmss(32, 31), mmss(33, 0)), '第三季度之前把黄金集补上...'),
      ],
    },
  },
}
/* 抽取器同形的样本(**不参与像素比对**,给组件测试与手工核对用):
   - 真实 pptx 抽取器每页只产出 1 个段落块(页内文字用 \n 分隔)+ 1 个 `备注:` 段落;
   - 真实音视频抽取器只有 1 个块,锚点是占位的 0–60000(没转写时再加一条 0–0 的提示)。 */
FILES.file_pptx_raw = {
  item: fileItem('file_pptx_raw', '真实形状-单段落.pptx', ['路线图']),
  preview: {
    format: 'pptx', editable: false, extractor: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    blocks: [
      // 一页 9 行:真实 deck 的常态,用来守住「画布要按内容长高、不能裁掉要点」
      blk(
        'paragraph',
        [
          '多格式解析与编辑',
          '批次 1 · PDF / Office / HTML / 邮件',
          '批次 2 · OCR / 音视频转写',
          '批次 3 · Notebook / 导出包',
          '里程碑 第三季度 · 质量检查',
          '黄金集 · 中文 PDF / 合并单元格 Excel',
          '离线可用 · 不外发',
          '风险 · 渲染引擎缺失',
          '下一步 · 版本历史 / 分享',
        ].join('\n'),
        slideAnchor(3),
      ),
      blk('paragraph', '备注:先讲批次 1 的收益。', slideAnchor(3)),
    ],
    chunks: [chunk('ck_raw_sl3', 1, slideAnchor(3), '多格式解析与编辑 批次 1 · PDF / Office / HTML / 邮件')],
  },
}
FILES.file_broken = {
  item: fileItem('file_broken', '原件已丢失.png', ['白板']),
  preview: {
    format: 'png', editable: false, extractor: null,
    read_error: '读不到原件: No such file or directory (os error 2)',
    blocks: [],
    chunks: [],
  },
}
FILES.file_m4a_raw = {
  item: fileItem('file_m4a_raw', '真实形状-单块.m4a', ['周会']),
  preview: {
    format: 'm4a', editable: false, extractor: 'audio|video/*',
    blocks: [blk('paragraph', '这是一整段录音的完整转写文本,抽取器把 52 分钟压成了一个块。', timeAnchor(0, 60))],
    chunks: [chunk('ck_raw_a1', 1, timeAnchor(0, 60), '这是一整段录音的完整转写文本')],
  },
}

/* ---------------- 真实原件(e2e/fixtures/sample.*,由 make-fixtures.py 生成)---------------- */
const RUST_SAMPLE = [
  '//! UDS 断线后的降级路径',
  'use std::path::Path;',
  '',
  '/// 守护进程不可达时,CLI 直读 SQLite(只读),跳过 rerank。',
  'pub fn degrade_read(root: &Path, query: &str) -> Result<Vec<Hit>, Error> {',
  '    let conn = open_readonly(root.join("meta.db"))?;',
  '    let hits = search_fts(&conn, query, 8)?; // BM25 only',
  '    eprintln!("degraded: uds unavailable");',
  '    Ok(hits)',
  '}',
  '',
  '#[cfg(test)]',
  'mod tests {',
  '    use super::*;',
  '',
  '    #[test]',
  '    fn falls_back_to_sqlite() {',
  '        assert!(degrade_read(Path::new("/tmp/kb"), "uds").is_ok());',
  '    }',
  '}',
].join('\n')
FILES.file_docx = {
  item: fileItem('file_docx', '向量检索综述.docx', ['论文']),
  preview: {
    format: 'docx', editable: false, extractor: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    blocks: [
      blk('heading', '向量检索综述 2025', null),
      blk('heading', '3.2 混合检索与倒数排名融合', null),
      blk('paragraph', '稠密向量检索擅长语义近似，但对专有名词与代码标识符的召回不稳定；稀疏检索（BM25）恰好互补。', null),
      blk('paragraph', '倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。', null),
    ],
    chunks: [chunk('ck_docx_2', 2, null, '倒数排名融合（RRF）以 1/(k+rank) 对各路结果加权求和，无需分数归一化，k 取 60 时在多数基准上表现稳健。')],
  },
}
FILES.file_rs = {
  item: fileItem('file_rs', 'kb-cli/src/degrade.rs', ['cli']),
  preview: {
    format: 'rs', editable: true, extractor: 'text/plain', content: RUST_SAMPLE,
    blocks: [blk('code', RUST_SAMPLE, { kind: 'line', start: 1, end: 20 })],
    chunks: [{ ...chunk('ck_rs_1', 1, { kind: 'line', start: 4, end: 10 }, RUST_SAMPLE.split('\n').slice(3, 10).join('\n')), start_line: 4, end_line: 10 }],
  },
}
FILES.file_csv = {
  item: fileItem('file_csv', '评测明细.csv', ['评测']),
  preview: {
    format: 'csv', editable: true, extractor: 'text/csv',
    content: ['编号,查询,命中名次,耗时(ms)', ...Array.from({ length: 400 }, (_, i) => `q${String(i + 1).padStart(3, '0')},"UDS 断线, 第 ${i + 1} 次",${(i % 7) + 1},${40 + ((i * 13) % 90)}`)].join('\n'),
    blocks: [blk('table', '编号 | 查询 | 命中名次 | 耗时(ms)\nq001 | UDS 断线 | 1 | 53', sheetAnchor('评测明细', 'A1:D2'))],
    chunks: [chunk('ck_csv_2', 1, sheetAnchor('评测明细', 'R3'), '编号=q002; 查询=UDS 断线, 第 2 次; 命中名次=2; 耗时=66')],
  },
}
// 在线编辑要用「上传的文件」才给出入口；样例字节仍由 /api/v1/raw 的 sample.xlsx 提供
FILES.file_xlsx.item.origin = 'upload'
FILES.file_xlsx.preview.origin = 'upload'
const SAMPLE_DIR = join(import.meta.dirname, 'fixtures')
const SAMPLE_TYPES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  svg: 'image/svg+xml',
}
/**
 * 预览原件:`e2e/fixtures/sample.<扩展名>` 存在就返回它的字节(与后端一致:PDF / Office / 其它非图片音视频一律 attachment)。
 * 本地想用真实文件验证时:`KB_SAMPLE_DOC=/path/to/real.doc node e2e/viewer-shots.mjs legacy-doc`(环境变量名是大写扩展名)。
 */
function sampleFor(path) {
  const name = String(path ?? '')
  const ext = /\.tar\.gz$/i.test(name) ? 'tar.gz' : (name.split('.').pop()?.toLowerCase() ?? '')
  const override = process.env[`KB_SAMPLE_${ext.toUpperCase().replace('.', '_')}`]
  const file = override || join(SAMPLE_DIR, `sample.${ext}`)
  if (!existsSync(file)) return null
  return { body: readFileSync(file), type: SAMPLE_TYPES[ext] ?? 'application/octet-stream' }
}

/* 更多格式的条目:没有抽取结果(blocks / chunks 为空)也得能看——这正是后端没有抽取器的老格式、二进制和未知扩展名的真实形状 */
const rawFile = (id, source, format, extra = {}) => {
  FILES[id] = {
    item: fileItem(id, source, []),
    preview: { format, editable: false, extractor: null, blocks: [], chunks: [], ...extra },
  }
}
rawFile('file_doc', '操作手册（旧版）.doc', 'doc')
rawFile('file_ppt', '路线图（旧版）.ppt', 'ppt')
rawFile('file_xls', '评测明细（旧版）.xls', 'xls')
rawFile('file_ods', '评测明细.ods', 'ods')
rawFile('file_odt', '向量检索综述.odt', 'odt')
rawFile('file_odp', '产品路线图.odp', 'odp')
rawFile('file_rtf', '样例.rtf', 'rtf')
rawFile('file_epub', '检索之书.epub', 'epub')
rawFile('file_eml', '周会纪要.eml', 'eml')
rawFile('file_mbox', '收件箱.mbox', 'mbox')
rawFile('file_ipynb', 'RRF 评测.ipynb', 'ipynb')
rawFile('file_zip', '样例包.zip', 'zip')
rawFile('file_tgz', '备份.tar.gz', 'gz')
rawFile('file_html', 'RRF 说明.html', 'html')
rawFile('file_svg', '架构图.svg', 'svg')
rawFile('file_dat', 'blob.dat', 'dat')
rawFile('file_weird', 'notes.weird', 'weird')
rawFile('file_md', 'README.md', 'md', {
  editable: true,
  content: '# README\n\n## 安装\n\n运行 `npm ci`。\n\n## 使用\n\n| 命令 | 说明 |\n|---|---|\n| `kb search` | 检索 |\n\n结尾段落。\n',
})
rawFile('file_cs', 'Hit.cs', 'cs', { editable: true, content: 'namespace Kb;\npublic class Hit { public int Rank { get; set; } }\n' })
const filePreviewVersions = [
  { id: 'v7', version: 7, author: 'dev', created_at: sh(10, 21, 14, 31), size: 1200, preview: '' },
  { id: 'v6', version: 6, author: 'dev', created_at: sh(10, 21, 11, 2), size: 1180, preview: '' },
  { id: 'v5', version: 5, author: 'DeepSeek', created_at: sh(10, 20, 23, 40), size: 1100, preview: '' },
]

// 邮件与邀请码(管理员页面用)。邮件设置:主账号已配好,备用账号没配
const T0 = 1_792_000_000_000
const fixtureMailStatus = {
  enabled: true,
  ready: true,
  from_name: '',
  per_minute: 30,
  primary: { preset: 'qq', host: 'smtp.qq.com', port: 465, security: 'tls', username: 'noreply@example.com', configured: true, password_set: true },
  backup: { preset: 'custom', host: '', port: 465, security: 'tls', username: '', configured: false, password_set: false },
  presets: [
    { id: 'qq', name: 'QQ 邮箱', host: 'smtp.qq.com', port: 465, security: 'tls' },
    { id: '163', name: '163 邮箱', host: 'smtp.163.com', port: 465, security: 'tls' },
    { id: '126', name: '126 邮箱', host: 'smtp.126.com', port: 465, security: 'tls' },
    { id: 'exmail', name: '腾讯企业邮', host: 'smtp.exmail.qq.com', port: 465, security: 'tls' },
    { id: 'aliyun', name: '阿里邮箱', host: 'smtp.mxhichina.com', port: 465, security: 'tls' },
  ],
  sent_last_hour: 12,
}
const fixtureMailLog = [
  { id: 4, at: T0 - 120_000, to_addr: 'lin.yi.long.address.for.wrapping@example-university.edu.cn', kind: 'register_code', ok: true, via: 'primary', error: null },
  { id: 3, at: T0 - 3_600_000, to_addr: 'bob@qq.com', kind: 'reset_code', ok: true, via: 'backup', error: null },
  { id: 2, at: T0 - 7_200_000, to_addr: 'alice@163.com', kind: 'register_code', ok: false, via: null, error: '535 Authentication failed: 授权码错误,请到邮箱设置里重新生成并填写(这是一段很长的服务器返回信息用来检查换行)' },
  { id: 1, at: T0 - 86_400_000, to_addr: 'admin@example.com', kind: 'test', ok: true, via: 'primary', error: null },
]
const fixtureInvites = [
  { invite: { id: 'inv_1', prefix: 'KB-7H2K', created_by: null, note: '内测第一批', max_uses: 1, used: 0, expires_at: T0 + 6 * 86_400_000, role_id: 'role_user', quota_json: '{}', revoked_at: null, created_at: T0 - 3_600_000 }, state: 'active' },
  { invite: { id: 'inv_2', prefix: 'KB-M4QX', created_by: null, note: '读书会(五十人)', max_uses: 50, used: 31, expires_at: null, role_id: null, quota_json: '{"storage_gb":5}', revoked_at: null, created_at: T0 - 5 * 86_400_000 }, state: 'active' },
  { invite: { id: 'inv_3', prefix: 'KB-9PCW', created_by: null, note: '', max_uses: 1, used: 1, expires_at: null, role_id: null, quota_json: '{}', revoked_at: null, created_at: T0 - 9 * 86_400_000 }, state: 'used_up' },
  { invite: { id: 'inv_4', prefix: 'KB-2ZTE', created_by: null, note: '已作废', max_uses: 3, used: 0, expires_at: null, role_id: null, quota_json: '{}', revoked_at: T0 - 86_400_000, created_at: T0 - 12 * 86_400_000 }, state: 'revoked' },
]

/** 需要看请求参数的能力。 */
/** 资源曲线假数据:范围内按步长造点,CPU / 内存缓慢起伏,磁盘慢慢涨 */
function fixtureMetrics(args) {
  const ranges = { '1h': [3_600_000, 10_000], '24h': [86_400_000, 120_000], '7d': [7 * 86_400_000, 900_000], '30d': [30 * 86_400_000, 3_600_000] }
  const [windowMs, stepMs] = ranges[args.range ?? '1h'] ?? ranges['1h']
  const n = Math.floor(windowMs / stepMs)
  const GB = 1024 ** 3
  const points = Array.from({ length: n }, (_, index) => {
    const t = index / n
    const cpu = 0.28 + 0.2 * Math.sin(t * 18) + 0.06 * Math.sin(t * 90)
    return { at: NOW - windowMs + index * stepMs, cpu, cpu_max: Math.min(1, cpu + 0.12), mem_used: (36 + 6 * Math.sin(t * 7)) * GB, mem_total: 62 * GB, load1: 2 + Math.sin(t * 12), disk_used: (410 + 40 * t) * GB, disk_total: 500 * GB, proc_cpu: 0.012 + 0.008 * Math.sin(t * 25) ** 2, proc_rss: (2 + 0.4 * Math.sin(t * 5)) * GB }
  })
  return { range: args.range ?? '1h', step_ms: stepMs, since: NOW - windowMs, until: NOW, cores: 16, points, now: points.at(-1) }
}

/** 活动趋势假数据:最近 N 天,工作日忙、周末闲,最后一天是夹具的今天 */
function fixtureActivity(args) {
  const n = Math.min(90, Math.max(1, args.days ?? 30))
  const days = Array.from({ length: n }, (_, index) => new Date(NOW - (n - 1 - index) * 86_400_000).toISOString().slice(0, 10))
  const wave = (base, amp, phase) => days.map((day, index) => (new Date(day).getUTCDay() % 6 === 0 ? Math.round(base * 0.2) : Math.max(0, Math.round(base + amp * Math.sin((index + phase) / 2.3)))))
  const imports = wave(6, 5, 3)
  return { days, notes: wave(3, 2, 0), edits: wave(9, 5, 1), imports, imports_done: imports.map((value) => Math.max(0, value - 1)), searches: wave(14, 8, 5), jobs_done: wave(40, 20, 2), ai_tokens: wave(20_000, 9_000, 4) }
}

/** 导入概况假数据:最近 N 小时,白天进得多,偶尔失败 */
function fixtureIngest(args) {
  const hours = Math.min(72, Math.max(1, args.hours ?? 24))
  const HOUR = 3_600_000
  const start = (Math.floor(NOW / HOUR) + 1) * HOUR - hours * HOUR
  const buckets = Array.from({ length: hours }, (_, index) => {
    const hour = new Date(start + index * HOUR).getUTCHours()
    const total = hour >= 1 && hour <= 10 ? 8 + ((index * 7) % 15) : (index * 3) % 4
    const failed = total > 12 ? 2 : total > 6 ? 1 : 0
    return { at: start + index * HOUR, total, done: Math.max(0, total - failed - (index === hours - 1 ? 2 : 0)), failed }
  })
  return {
    by_state: [{ state: 'done', count: 1180 }, { state: 'skipped', count: 64 }, { state: 'failed', count: 23 }, { state: 'embedding', count: 6 }, { state: 'queued', count: 12 }, { state: 'quarantined', count: 3 }],
    start,
    step_ms: HOUR,
    buckets,
    top_errors: [{ error: '抽取超时(超过 60 秒)', count: 11 }, { error: '没有可识别的文字(扫描件需要文字识别)', count: 7 }, { error: '文件已损坏', count: 5 }],
  }
}

/** 项目文件状态假数据:和夹具里的项目集合对上 */
function fixtureFileStats() {
  return {
    collections: [
      { collection: 'proj_knowledgebase', statuses: { ok: 3114, binary: 820, excluded: 410, too_large: 36, generated: 120 }, total: 4500 },
      { collection: 'proj_sampleapp', statuses: { ok: 4206, binary: 1650, excluded: 2300, too_large: 14, generated: 530, error: 8 }, total: 8708 },
      { collection: 'proj_sampleproj', statuses: { ok: 18200, binary: 5400, excluded: 3100, generated: 900 }, total: 27600 },
    ],
  }
}

/** 全站 AI 用量趋势假数据:按 UTC 日期,提炼和审核为主 */
function fixtureLlmSeries(args) {
  const n = Math.min(90, Math.max(1, args.days ?? 30))
  const days = Array.from({ length: n }, (_, index) => new Date(NOW - (n - 1 - index) * 86_400_000).toISOString().slice(0, 10))
  const wave = (base, amp, phase) => days.map((_, index) => Math.max(0, Math.round(base + amp * Math.sin((index + phase) / 2.7))))
  const extract = wave(42_000, 30_000, 0)
  const review = wave(18_000, 9_000, 2)
  const agent = wave(9_000, 7_000, 5)
  return { days, purposes: ['agent', 'extract', 'review'], series: { agent, extract, review }, totals: days.map((_, index) => agent[index] + extract[index] + review[index]) }
}

/** 审计概况假数据:工作日白天忙,夜里和周末稀疏 */
function fixtureAuditStats(args) {
  const days = Math.min(90, Math.max(1, args.days ?? 30))
  const heat = Array.from({ length: 7 }, (_, row) =>
    Array.from({ length: 24 }, (_, hour) => {
      const work = row < 5 && hour >= 9 && hour <= 18
      const wave = Math.round(6 + 14 * Math.sin(((hour - 8) / 10) * Math.PI))
      return Math.round(((work ? Math.max(4, wave) : hour >= 20 && hour <= 23 ? 3 : 0) * days) / 30) + ((row * 7 + hour * 3) % 3)
    }),
  )
  const top = [
    { capability: 'search_knowledge', count: 412, failed: 6 },
    { capability: 'save_insight', count: 188, failed: 21 },
    { capability: 'edit_item', count: 143, failed: 2 },
    { capability: 'add_project', count: 64, failed: 9 },
    { capability: 'update_project', count: 51, failed: 1 },
    { capability: 'create_token', count: 22, failed: 0 },
    { capability: 'delete_item', count: 14, failed: 3 },
  ]
  const total = heat.flat().reduce((sum, value) => sum + value, 0)
  return { days, heat, top, total, failed: top.reduce((sum, row) => sum + row.failed, 0) }
}

export const dynamicResponses = {
  audit_stats: fixtureAuditStats,
  ingest_stats: fixtureIngest,
  project_file_stats: fixtureFileStats,
  llm_usage_series: fixtureLlmSeries,
  activity_series: fixtureActivity,
  metrics_series: fixtureMetrics,
  mail_status: () => fixtureMailStatus,
  mail_log: () => ({ log: fixtureMailLog }),
  mail_password: (args) => ({ slot: args.slot, password_set: String(args.password ?? '') !== '' }),
  mail_test: (args) => ({ ok: args.slot === 'primary', slot: args.slot, to: args.to ?? 'admin@example.com', error: args.slot === 'primary' ? null : '备用发件邮箱还没有配置' }),
  invite_list: () => ({ invites: fixtureInvites, now: T0 }),
  invite_create: (args) => ({
    invites: Array.from({ length: args.count ?? 1 }, (_, index) => ({
      invite: { ...fixtureInvites[0].invite, id: `inv_new${index}`, prefix: `KB-NEW${index}` },
      code: `KB-N${index}WA-B${index}CD`,
    })),
  }),
  invite_revoke: (args) => ({ id: args.id, revoked: true }),
  invite_uses: () => ({ uses: [{ user_id: 'usr_alice', username: 'alice', ip: '203.0.113.7', at: T0 - 3_600_000 }, { user_id: 'usr_bob', username: null, ip: null, at: T0 - 86_400_000 }] }),
  feature_catalog: () => ({ features: FIXTURE_FEATURES }),
  role_list: () => ({ roles: fixtureRoles }),
  role_create: (args) => ({ role: { id: 'role_new', name: args.name, description: args.description ?? '', builtin: false, all_features: false, dangerous: false, quota_json: '{}', features: args.features ?? [], user_count: 0 } }),
  role_update: (args) => ({ role: { ...(fixtureRoles.find((role) => role.id === args.id) ?? fixtureRoles[1]), ...(args.features ? { features: args.features } : {}) } }),
  user_feature: () => ({}),
  user_update: (args) => ({ user: { ...(fixtureUsers.find((user) => user.id === args.id) ?? fixtureUsers[1]), ...(args.status ? { status: args.status } : {}) } }),
  user_set_password: (args) => ({ id: args.id, password_set: true }),
  user_create: (args) => ({ user: { ...fixtureUsers[1], id: 'usr_new', username: args.username } }),
  role_delete: (args) => ({ id: args.id, deleted: true }),
  user_list: () => ({ users: fixtureUsers, total: fixtureUsers.length, page: 1, page_size: 30 }),
  // 好友:默认三位好友(含一个很长的名字),巡检脚本(sweep / clipcheck)才看得到带数据的好友页;场景用 __social 换成有状态的假后端
  friend_list: () => ({
    friends: [
      { id: 'usr_bob', username: 'bob', display_name: 'Bob', avatar: null, remark: '产品部小林', group_name: '同事', since: T0 - 5 * 86_400_000 },
      { id: 'usr_carol', username: 'carol', display_name: 'Carol', avatar: null, remark: null, group_name: null, since: T0 - 40 * 86_400_000 },
      { id: 'usr_long', username: 'a_very_long_username_for_wrap', display_name: '一个名字特别特别特别特别长的好友用来检查手机上的折行与省略', avatar: null, remark: null, group_name: '一个同样特别特别长的分组名', since: T0 - 400 * 86_400_000 },
    ],
  }),
  notification_prefs: (args) => ({
    email: { friend_request: true, friend_result: false, share_received: true, access_request: true, access_result: true, comment_reply: false, mention: true, collaborator_removed: false, link_expiring: false, announcement: false, ...(args?.email ?? {}) },
    kinds: ['friend_request', 'friend_result', 'share_received', 'access_request', 'access_result', 'comment_reply', 'mention', 'collaborator_removed', 'link_expiring', 'announcement'],
    mail_available: true,
  }),
  block_list: () => ({ blocked: [{ user: { id: 'usr_spam', username: 'spam_account', display_name: '一个名字特别特别特别特别长的骚扰账号用来检查折行', avatar: null }, since: T0 - 3 * 86_400_000 }] }),
  privacy_get: () => ({ privacy: { searchable_by_email: false, searchable_by_username: true, share_from: 'everyone' } }),
  friend_requests: () => ({
    incoming: [
      { id: 'frq_1', from: { id: 'usr_zhao', username: 'zhaoliu', display_name: '赵六', avatar: null }, message: '我是上周的同事,想把部署清单分享给你,方便一起改,谢谢!', created_at: T0 - 2 * 3_600_000, expires_at: T0 + 5 * 86_400_000 },
    ],
    outgoing: [
      { id: 'frq_2', to: { id: 'usr_erin', username: 'erin', display_name: 'Erin', avatar: null }, message: null, created_at: T0 - 86_400_000, expires_at: T0 + 6 * 86_400_000 },
    ],
  }),
  user_get: (args) => ({
    user: fixtureUsers.find((user) => user.id === args.id) ?? fixtureUsers[1],
    space: { id: 'sp_x', storage_bytes: 3_145_728 },
    overrides: [{ feature: 'ai.acp', effect: 'allow' }],
    effective_features: ['docs.notes', 'search.basic', 'ai.acp'],
  }),
  // 浏览器左栏二级:insight 子类型 → 目录(后端 item_facets 能力,见 实测报告「待后端」)
  item_facets: (args) =>
    args?.collection === 'knowledgeBase/insights'
      ? {
          kinds: [
            { kind: 'decision', count: 61, dirs: [] },
            { kind: 'pitfall', count: 143, dirs: [{ dir: 'kb-service/', count: 52 }, { dir: 'kb-cli/', count: 38 }, { dir: 'kb-core/', count: 53 }] },
            { kind: 'pattern', count: 190, dirs: [] },
            { kind: 'howto', count: 88, dirs: [] },
          ],
        }
      : { kinds: [] },
  list_items: (args) => {
    const kind = args?.kind
    const pageSize = Number(args?.page_size ?? 12)
    if (kind === 'insight') return { items: browserRows.slice(0, pageSize), total: 143, page: 1, page_size: pageSize }
    if (kind === 'code') return { items: fixture.code, total: 52, page: 1, page_size: pageSize }
    if (kind === 'doc') return { items: [], total: 53, page: 1, page_size: pageSize }
    return { items: browserRows.slice(0, pageSize), total: 38, page: 1, page_size: pageSize }
  },
  file_preview: (args) => Object.values(FILES).find((entry) => entry.item.source === args?.path)?.preview ?? { format: 'md', blocks: [], chunks: [] },
  // 旧 Office 编辑入口先问原件哈希 / 来源；上传文件才能拿编辑权
  file_info: (args) => ({
    sha256: args?.path && String(args.path).endsWith('.xlsx') ? 'sha-fixture-original' : 'sha-fixture',
    origin: args?.path && String(args.path).endsWith('.xlsx') ? 'upload' : 'project',
    max_replace_bytes: 64 * 1024 * 1024,
  }),
  // 超过整份读入上限 / 非 UTF-8 的 CSV 要按页读（csv_read）；其余情况原生网格直接吃 file_preview.content，不走这里
  csv_read: (args) => {
    const text = FILES.file_csv.preview.content
    const lines = text.split('\n')
    const offset = Number(args?.offset ?? 0)
    const limit = Number(args?.limit ?? 200)
    return {
      total_rows: lines.length,
      columns: 4,
      rows: lines.slice(offset, offset + limit).map((line) => line.split(',')),
      offset,
      format: { encoding: 'utf-8', encoding_label: 'UTF-8', delimiter: ',', newline: 'lf', trailing_newline: false },
      sha256: 'csv-fixture',
      version: 1,
    }
  },
  csv_edit: (args) => ({ changed: true, version: 2, embedded: 0, sha256: 'csv-fixture-2', ops: args?.ops?.length ?? 0 }),
  file_versions: () => ({ versions: filePreviewVersions }),
  save_file: () => ({ version: 8, embedded: 3, chunks: 3 }),
  edit_item: (args) => ({ id: args?.id ?? 'ins_8f21', version: 4, job_id: null }),
  create_item: () => ({ id: 'ins_new1' }),
  list_annotations: () => ({
    annotations: [
      { id: 'an1', body: '这里的 k 取值需要和评测集对齐', author: 'dev', anchor: null, created_at: sh(10, 21, 10, 0) },
      { id: 'an2', body: '重排超时降级要写进设计说明', author: 'DeepSeek', anchor: null, created_at: sh(10, 21, 12, 30) },
      { id: 'an3', body: '表格数值按 nDCG@10 复核过', author: 'Kiro', anchor: null, created_at: sh(10, 21, 15, 10) },
    ],
  }),
  get_item: (args) => {
    if (FILES[args?.id]) return { item: FILES[args.id].item, context: null }
    const row = browserRows.find((entry) => entry.id === args?.id) ?? browserRows[0]
    // 200 KB 笔记样本：只在本脚本进程里用环境变量打开，避免把大正文塞进所有截图用例。
    const note200k = process.env.KB_NOTE_200K === '1' ? readFileSync(join(import.meta.dirname, 'fixtures', 'editor', 'note-200k.md'), 'utf8') : null
    return {
      item: {
        ...row,
        text: note200k && args?.id === 'ins_8f21' ? note200k : browserBody,
        header: row.title,
        tags: ['uds', 'degrade', 'cli'],
        origin: 'evolve · diff 1ed7abb',
        embedded_at: sh(10, 21, 0, 41),
      },
      context: null,
    }
  },
  item_history: (args) => ({
    items: [
      { id: `${args?.id}_v1`, title: '', version: 1, status: 'active', at: sh(10, 20, 23, 42), note: '提炼自需求变更 diff · drf_51a' },
      { id: `${args?.id}_v2`, title: '', version: 2, status: 'superseded', at: sh(10, 21, 0, 39), note: '审核通过 · qwen2.5-14b · 无重复 (max sim 0.71)' },
      { id: args?.id ?? 'ins_8f21', title: '', version: 3, status: 'active', at: sh(10, 21, 0, 41), note: '转正 → insights + LanceDB' },
    ],
  }),
}

// 管理端(存储与用量、AI 额度排行、我的用量、分享治理)的夹具在单独的文件里
Object.assign(dynamicResponses, adminResponses)
/** 各上下文里某个能力已经被 `__capabilityError` 拦下的次数 */
const failureSeen = new WeakMap()

/** 把 `/api/v1/**` 全部拦下来,按能力名返回 fixture。 */
const uploadSessions = new Map()

/** 全部功能点(与 kb-core features 目录一致) */
export const ALL_FEATURES = [
  'docs.notes', 'docs.upload', 'docs.edit_text', 'docs.annotate', 'search.basic', 'search.deep', 'search.tune',
  'ai.extract', 'ai.organize', 'ai.assistant', 'ai.acp', 'sources.web', 'sources.local', 'collab.friends',
  'collab.share', 'collab.link_users', 'collab.link_guest', 'collab.edit', 'api.tokens', 'sys.users',
  'sys.settings', 'sys.ops',
]

const FIXTURE_FEATURES = [
  ['docs.notes', '文档', '新建、编辑和删除笔记', '', false, false],
  ['docs.upload', '文档', '上传文件与附件', '', false, false],
  ['search.basic', '检索', '检索', '', false, false],
  ['search.deep', '检索', '深度检索', '调用大模型改写查询', false, true],
  ['ai.extract', 'AI', '自动提炼与审核', '', false, true],
  ['ai.acp', 'AI', '编码代理(ACP)', '', false, true],
  ['sys.users', '系统', '用户、角色与邀请码', '只应授予管理员', true, false],
].map(([id, group, label, hint, dangerous, ai]) => ({ id, group, label, hint, default_user: !dangerous && id !== 'ai.acp', dangerous, ai }))

/** 夹具里的当前用户:`features` 缺省 = 全部。 */
export const fixtureRoles = [
  { id: 'role_admin', name: '管理员', description: '拥有全部功能', builtin: true, all_features: true, dangerous: true, quota_json: '{}', features: [], user_count: 1 },
  { id: 'role_user', name: '普通用户', description: '新注册用户的默认角色', builtin: true, all_features: false, dangerous: false, quota_json: '{}', features: ['docs.notes', 'docs.upload', 'search.basic', 'search.deep', 'ai.extract'], user_count: 2 },
]
export const fixtureUsers = [
  { id: 'usr_admin', username: 'admin', email: null, display_name: '管理员', role_id: 'role_admin', status: 'active', registered_via: 'migrated', created_at: 1, last_login_at: 1_792_000_000_000 },
  { id: 'usr_alice', username: 'alice', email: 'alice@example.com', display_name: 'Alice', role_id: 'role_user', status: 'active', registered_via: 'email', created_at: 2, last_login_at: null },
  { id: 'usr_bob', username: 'bob', email: null, display_name: 'Bob', role_id: 'role_user', status: 'disabled', registered_via: 'admin', created_at: 3, last_login_at: null },
]

// ---------------------------------------------------------------- 个人设置用的样例
function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}
function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data])
  const out = Buffer.alloc(8 + data.length + 4)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body), 8 + data.length)
  return out
}
/** 现场画一张 `size`×`size` 的渐变 PNG(头像样例),不用提交二进制文件。 */
export function gradientPng(size = 256, hue = 'blue') {
  const rows = []
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 3)
    for (let x = 0; x < size; x += 1) {
      const t = (x + y) / (2 * size)
      const [r, g, b] = hue === 'green' ? [40, 120 + 100 * t, 80] : [60 + 60 * t, 90 + 80 * t, 200 - 40 * t]
      row[1 + x * 3] = r
      row[2 + x * 3] = g
      row[3 + x * 3] = b
    }
    rows.push(row)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

const MIN = 60_000
const fixtureSessions = [
  { id: '1a2b3c4d5e6f7081', current: true, device: 'Chrome · macOS', ip: '203.0.113.7', created_at: 1_792_000_000_000 - 2 * 86_400_000, last_seen: 1_792_000_000_000 - MIN, expires_at: 1_792_000_000_000 + 5 * 86_400_000 },
  { id: '2b3c4d5e6f708192', current: false, device: 'Safari · iPhone', ip: '198.51.100.23', created_at: 1_792_000_000_000 - 5 * 86_400_000, last_seen: 1_792_000_000_000 - 3 * 3_600_000, expires_at: 1_792_000_000_000 + 2 * 86_400_000 },
  { id: '3c4d5e6f708192a3', current: false, device: '未知设备', ip: null, created_at: 1_792_000_000_000 - 6 * 86_400_000, last_seen: 1_792_000_000_000 - 4 * 86_400_000, expires_at: 1_792_000_000_000 + 86_400_000 },
]

export function adminMe(features = ALL_FEATURES, aiEnabled = true) {
  return {
    id: 'usr_admin', username: 'admin', email: null, email_verified: false, display_name: '管理员',
    avatar: null, role_id: 'role_admin', status: 'active', must_change_password: false, space_id: 'sp_primary',
    features, ai_enabled: aiEnabled,
  }
}


/**
 * 任务假后端(卡 A):job_list 按参数筛选、排序、分页,job_stats 在同一份任务上统计,job_get 的摘要模式。
 * 规则和 kb-meta 的 list_page / stats 一致(运行中 → 排队 → 按结束时间倒序;用时分段含上界)。
 * 场景里写的 `job_list: { jobs: [...] }` 会被当成「这份任务表」,统计也按它算,不会和表格对不上。
 */
export function fakeJobs(all) {
  const rank = (state) => (state === 'running' ? 0 : state === 'queued' ? 1 : 2)
  const end = (job) => job.finished_at ?? job.created_at
  const pick = (args = {}) => {
    const states = [...(args.states ?? []), ...(args.state ? [args.state] : [])]
    const kinds = args.kinds ?? []
    const exclude = args.exclude_kinds ?? []
    return all.filter((job) => (!states.length || states.includes(job.state)) && (!kinds.length || kinds.includes(job.kind)) && !exclude.includes(job.kind) && (!args.collection || job.collection === args.collection))
  }
  return {
    job_list: (args = {}) => {
      const sorted = pick(args).sort((a, b) => rank(a.state) - rank(b.state) || (rank(a.state) < 2 ? a.created_at - b.created_at : end(b) - end(a)) || String(a.id).localeCompare(String(b.id)))
      const page = Math.max(1, args.page ?? 1)
      const size = Math.min(200, Math.max(1, args.page_size ?? 50))
      return { jobs: sorted.slice((page - 1) * size, page * size), total: sorted.length, page, page_size: size }
    },
    job_stats: (args = {}) => {
      const jobs = pick({ exclude_kinds: args.exclude_kinds, collection: args.collection })
      const by_state = { queued: 0, running: 0, paused: 0, done: 0, failed: 0, canceled: 0 }
      const kinds = new Map()
      for (const job of jobs) {
        by_state[job.state] = (by_state[job.state] ?? 0) + 1
        kinds.set(job.kind, (kinds.get(job.kind) ?? 0) + 1)
      }
      // 「最近 24 小时」按夹具的时间算(浏览器时钟也固定在 NOW)
      const since = NOW - 24 * 3600_000
      const recent = jobs.filter((job) => end(job) > since)
      const count = (state) => recent.filter((job) => job.state === state).length
      const spansOf = (list) => list.filter((job) => job.state === 'done' && job.started_at && job.finished_at && job.finished_at >= job.started_at).map((job) => job.finished_at - job.started_at)
      const recentSpans = spansOf(recent)
      const spans = spansOf(jobs).sort((a, b) => a - b)
      const edges = [10_000, 60_000, 300_000, 1_800_000]
      const buckets = [0, 0, 0, 0, 0]
      for (const span of spans) {
        const at = edges.findIndex((edge) => span <= edge)
        buckets[at === -1 ? 4 : at]++
      }
      const mid = Math.floor(spans.length / 2)
      const queued = jobs.filter((job) => job.state === 'queued').map((job) => job.created_at)
      // 序列:最后一个桶包含夹具的「现在」,桶数 / 宽度和后端一致
      const windows = { '24h': [3_600_000, 24], '7d': [6 * 3_600_000, 28], '30d': [86_400_000, 30] }
      let series
      if (windows[args.range]) {
        const [stepMs, n] = windows[args.range]
        const start = (Math.floor(NOW / stepMs) + 1) * stepMs - stepMs * n
        const at = (value) => Math.floor((value - start) / stepMs)
        const buckets = Array.from({ length: n }, (_, index) => ({ at: start + index * stepMs, created: 0, done: 0, failed: 0, canceled: 0, avg_ms: null, queue_depth: 0 }))
        for (const job of jobs) {
          if (at(job.created_at) >= 0 && at(job.created_at) < n) buckets[at(job.created_at)].created++
          if (job.finished_at && at(job.finished_at) >= 0 && at(job.finished_at) < n) buckets[at(job.finished_at)][{ done: 'done', failed: 'failed', canceled: 'canceled' }[job.state] ?? 'done']++
          const leave = job.started_at ?? job.finished_at
          for (let index = Math.max(0, at(job.created_at)); index < (leave ? Math.min(n, at(leave)) : n); index++) buckets[index].queue_depth++
        }
        series = { range: args.range, start, step_ms: stepMs, buckets }
      }
      const running = jobs.filter((job) => job.state === 'running').sort((a, b) => (a.started_at ?? a.created_at) - (b.started_at ?? b.created_at))[0]
      return {
        total: jobs.length,
        by_state,
        kinds: [...kinds.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([kind, n]) => ({ kind, count: n })),
        recent: { hours: 24, since, done: count('done'), failed: count('failed'), canceled: count('canceled'), avg_ms: recentSpans.length ? recentSpans.reduce((sum, value) => sum + value, 0) / recentSpans.length : null },
        ...(series ? { series } : {}),
        queue: { oldest_queued_at: queued.length ? Math.min(...queued) : null, first_running: running ? { kind: running.kind, collection: running.collection ?? null } : null },
        durations: {
          edges_ms: edges,
          buckets,
          count: spans.length,
          median_ms: spans.length ? (spans.length % 2 ? spans[mid] : (spans[mid - 1] + spans[mid]) / 2) : null,
          p95_ms: spans.length ? spans[Math.max(1, Math.ceil(spans.length * 0.95)) - 1] : null,
        },
      }
    },
    job_get: (args = {}) => {
      const job = all.find((item) => item.id === args.id) ?? all[0] ?? null
      if (!job || !args.brief) return { job }
      const failed = job.state === 'failed'
      return {
        job: {
          ...job,
          payload: { project_id: 'p1', mode: job.kind === 'reindex' ? 'full' : 'incremental', paths: job.kind === 'reindex' ? [] : { total: 1284, items: ['src/main.rs', 'src/lib.rs'] } },
          checkpoint: { done: job.progress_done, total: job.progress_total, embedded: job.progress_done * 4, errors: failed ? 2 : 0, error_samples: failed ? ['docs/big.pdf: 抽取超时', 'docs/scan.pdf: 没有可识别的文字'] : [] },
        },
      }
    },
  }
}

export async function installFixture(context, overrides = {}) {
  // 任务三件套按「这份任务表」动态回答(见 fakeJobs);场景自己给了函数或错误的,照场景的来
  {
    const given = overrides.job_list
    if (given === undefined || (given && typeof given === 'object' && Array.isArray(given.jobs))) {
      const jobsApi = fakeJobs(given?.jobs ?? fixture.jobs)
      overrides = { ...overrides, job_list: jobsApi.job_list }
      if (overrides.job_stats === undefined) overrides.job_stats = jobsApi.job_stats
      if (overrides.job_get === undefined) overrides.job_get = jobsApi.job_get
    }
  }
  // auth/status 已经按 __authStatusFail 失败了几次(每个浏览器上下文各数各的,不能放在被多个场景共享的 overrides 对象上)
  let authStatusFailures = 0
  // 浏览器页「最近查看」(本机 localStorage)——与设计稿一致
  await context.addInitScript(() => {
    if (!localStorage.getItem('kb.browser.recent')) {
      localStorage.setItem(
        'kb.browser.recent',
        JSON.stringify([
          { id: 'ins_7d02', title: 'rerank 超时降级' },
          { id: 'ins_6f30', title: 'stdio 日志' },
        ]),
      )
    }
  })
  // 个人设置的可变状态(每个 context 一份,场景之间互不影响):头像、昵称、登录设备
  const profile = { avatar: overrides.__profile?.avatar ?? null, display_name: overrides.__profile?.display_name ?? null, hue: 'blue', rejectAvatar: false, deleteAfter: overrides.__profile?.deleteAfter ?? null, email: 'admin@example.com', pendingEmail: null, export: overrides.__export ? { ...overrides.__export } : { state: 'idle', left: 3, polls: 0 } }
  let sessions = fixtureSessions.map((item) => ({ ...item }))
  const profileLog = []
  const avatarLog = []
  // Office 在线编辑的服务端替身：保存请求逐条记录，场景直接读同一个数组断言。
  // 场景预先传进来就复用同一个对象（installFixture 内部会浅拷贝 overrides，引用必须共享）。
  const officeEdit = overrides.__officeEdit ?? {}
  officeEdit.replaces ??= []
  officeEdit.locks ??= []
  officeEdit.conflict ??= false
  officeEdit.held ??= true
  overrides.__officeEdit = officeEdit
  const sessionsFails = { n: 0 }
  // 两步验证:状态机。overrides.__totp 预置 {enabled, required, left, status};overrides.__totpGate 打开后,
  // 没开启两步验证时除 /api/v1/auth/ 以外的接口都返回 403 totp_setup_required(站点强制管理员开启时后端的真实行为)。
  // 约定:当前密码是 old-password-1(与 change-password 一致),有效的验证码是 123456,429429 触发限速;
  // 登录挑战 chal-1 有效,chal-expired 已过期。请求记录用 /api/v1/__fixture/totp 读出来。
  const totp = {
    enabled: overrides.__totp?.enabled ?? false,
    required: overrides.__totp?.required ?? false,
    left: overrides.__totp?.left ?? 8,
    used: new Set(),
    generation: 0,
    calls: [],
  }
  const TOTP_RECOVERY = (generation) => Array.from({ length: 8 }, (_, i) => `ABCD-EFGH-${'JKMNPQRS'[i]}${generation + 2}${'TUVWXYZ2'[i]}${'3456789A'[i]}`)
  // 个人访问令牌(POST /api/v1/auth/tokens 创建、DELETE /api/v1/auth/tokens/<id> 撤销);overrides.__tokens 换掉初始列表(后端真实形状)
  const tokenState = { created: [], revoked: new Map(), calls: [] }
  // 用户偏好(GET/PUT /api/v1/me/prefs):整体替换语义、不超过 8KB、写入要带 X-KB-CSRF: 1。
  // 用例用 overrides.__prefs 预置服务端已有的偏好,用 overrides.__prefsFail 让读写都失败(验证「失败静默」)
  const prefsState = { prefs: structuredClone(overrides.__prefs ?? {}), puts: 0 }
  const adminKeyState = { key: overrides.__adminKey ?? `kb_ak_${'ab12'.repeat(12)}`, rotatedAt: null, rotations: 0, guideCalls: [] }
  // 通知(后端已上线):notification_list 入参 {unread_only?, before_id?, limit?} → {notifications, unread, next_before_id};
  // notification_read 入参 {ids?, all?}。用例用 overrides.__notifications 预置;默认两条未读 + 一条已读。
  const notifState = {
    items: structuredClone(
      overrides.__notifications ?? [
        { id: 3, kind: 'friend.request', data: { from: 'zhaoliu' }, read_at: null, created_at: NOW - 5 * MINUTE },
        { id: 2, kind: 'access.request', data: { doc: '部署清单' }, read_at: null, created_at: NOW - 2 * HOUR },
        { id: 1, kind: 'share.added', data: { doc: '接口约定' }, read_at: NOW - DAY, created_at: NOW - 2 * DAY },
      ],
    ),
    reads: [],
  }
  const unreadOf = () => notifState.items.filter((item) => !item.read_at).length
  // 好友:用例用 overrides.__social 预置,好友 / 申请 / 拉黑 / 隐私能力由 fixture-social.mjs 的有状态假后端处理
  const social = overrides.__social ? createSocial(overrides.__social, NOW) : null
  // 实时推送:__live 打开时接管 /api/v1/ws,测试里用 pushLive(context, 事件) 往页面推一帧
  if (overrides.__live) {
    const sockets = (liveSockets.get(context) ?? []).slice()
    liveSockets.set(context, sockets)
    await context.routeWebSocket(/\/api\/v1\/ws$/, (ws) => {
      sockets.push(ws)
      ws.onClose(() => sockets.splice(sockets.indexOf(ws), 1))
    })
  }
  await context.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url())
    const json = (body, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

    // 预览器按附件名取原件：PDF / Office 的字节来自本机 fixtures/sample.<ext>。
    // 以前只有 /raw 有实现，/download 落到通用 {ok:{}} 上空响应，PdfViewer 会误报「文件已损坏」。
    if (url.pathname === '/api/v1/download') {
      const sample = sampleFor(url.searchParams.get('path'))
      if (sample) {
        return route.fulfill({
          status: 200,
          contentType: sample.type,
          headers: { 'content-disposition': `attachment; filename="sample"`, 'x-content-type-options': 'nosniff' },
          body: sample.body,
        })
      }
      return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { message: '没有这份原件' } }) })
    }
    // 预览页的原件(图片 / 音频)走 `GET /api/v1/raw`:比对环境里没有真实文件,
    // 返回一张中性占位图,避免出现“裂图”把版面差异算成内容差异
    if (url.pathname === '/api/v1/raw') {
      const sample = sampleFor(url.searchParams.get('path'))
      if (sample) {
        return route.fulfill({
          status: 200,
          contentType: sample.type,
          headers: { 'content-disposition': 'attachment; filename="sample"', 'x-content-type-options': 'nosniff' },
          body: sample.body,
        })
      }
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#eceff3"/><text x="320" y="186" fill="#9aa3b2" font-family="sans-serif" font-size="16" text-anchor="middle">原件(比对占位)</text></svg>`
      return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg })
    }
    // ---- 个人设置:资料、头像、登录设备。profileLog 只用来让每次上传得到不同的头像文件名(和真实服务器一样,换头像文件名就变)
    const method = route.request().method()
    if (overrides.__totpGate && !totp.enabled && !/^\/api\/v1\/(auth\/|health|__fixture\/)/.test(url.pathname)) {
      totp.calls.push({ method, path: url.pathname, blocked: true })
      return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'totp_setup_required', message: '站点要求管理员开启两步验证,请先到个人设置里开启' } }) })
    }
    // 编辑器扩展:按后端真实响应形状应答(crates/kb-web/src/editor_ext.rs)。
    // overrides.__editorExt = { enabled, forbidden, dir, extensions: [{ id, dir, manifest, error }], files: { '<id>/<文件>': 内容 } };
    // 场景持有同一个对象的引用,运行中改它(例如 enabled=false)就等于管理员改了 config.toml。
    if (url.pathname === '/api/v1/editor/extensions' && method === 'GET') {
      const ext = overrides.__editorExt ?? { enabled: false, extensions: [] }
      if (ext.forbidden) return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'forbidden', message: '编辑器扩展只对管理员开放' } }) })
      return json(ok(ext.enabled ? { enabled: true, dir: ext.dir ?? '/srv/kb/.kb/editor-extensions', extensions: ext.extensions ?? [] } : { enabled: false, extensions: [] }))
    }
    const extFile = /^\/api\/v1\/editor\/extensions\/([^/]+)\/(.+)$/.exec(url.pathname)
    if (extFile && method === 'GET') {
      const ext = overrides.__editorExt ?? { enabled: false }
      const body = ext.enabled && !ext.forbidden ? ext.files?.[`${extFile[1]}/${extFile[2]}`] : undefined
      if (body === undefined) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'not_found', message: '找不到这个扩展文件' } }) })
      const type = extFile[2].endsWith('.css') ? 'text/css; charset=utf-8' : extFile[2].endsWith('.json') ? 'application/json' : 'text/javascript; charset=utf-8'
      return route.fulfill({ status: 200, contentType: type, headers: { 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' }, body })
    }
    if (url.pathname === '/api/v1/me/prefs') {
      if (overrides.__prefsFail) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { message: '偏好服务不可用' } }) })
      if (method === 'GET') return json(ok({ prefs: prefsState.prefs }))
      if (method === 'PUT') {
        if (route.request().headers()['x-kb-csrf'] !== '1') return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { message: '缺少 CSRF 头' } }) })
        const text = route.request().postData() ?? ''
        if (Buffer.byteLength(text) > 8 * 1024) return route.fulfill({ status: 413, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { message: '偏好不能超过 8KB' } }) })
        const body = JSON.parse(text || '{}')
        if (!body.prefs || typeof body.prefs !== 'object' || Array.isArray(body.prefs)) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { message: 'prefs 必须是对象' } }) })
        // __prefsReadOnly:收下写入(计数)但不改变之后 GET 读到的内容,让「逐页收起」这类场景不受上一页写回的影响
        if (!overrides.__prefsReadOnly) prefsState.prefs = body.prefs
        prefsState.puts += 1
        return json(ok({ prefs: prefsState.prefs }))
      }
    }
    // 用户 admin key 与 AI 接入指南:轮换会换 key(旧值不再出现);overrides.__adminKeyFail 让读取失败
    if (url.pathname === '/api/v1/me/admin-key' && method === 'GET') {
      if (overrides.__adminKeyFail) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'internal', message: '账号服务暂时不可用' } }) })
      return json(ok({ admin_key: adminKeyState.key, created_at: NOW - 3 * DAY, rotated_at: adminKeyState.rotatedAt }))
    }
    if (url.pathname === '/api/v1/me/admin-key/rotate' && method === 'POST') {
      adminKeyState.rotations += 1
      adminKeyState.key = `kb_ak_${String(adminKeyState.rotations).padStart(2, '0')}${'cd34'.repeat(11)}${'ef'}`
      adminKeyState.rotatedAt = NOW
      return json(ok({ admin_key: adminKeyState.key, created_at: NOW - 3 * DAY, rotated_at: adminKeyState.rotatedAt }))
    }
    if (url.pathname === '/api/v1/me/ai-guide' && method === 'GET') {
      adminKeyState.guideCalls.push(url.search)
      const body = `# 团队知识库 · AI 接入指南\n\nadmin key: ${adminKeyState.key}\n`
      const headers = url.searchParams.get('download') ? { 'content-disposition': 'attachment; filename="knowledgebase-ai-guide.md"' } : {}
      return route.fulfill({ status: 200, contentType: 'text/markdown; charset=utf-8', headers, body })
    }
    if (url.pathname === '/api/v1/__fixture/admin-key') return json(ok({ ...adminKeyState }))
    // 测试钩子:读出夹具里当前的偏好和被写过几次
    if (url.pathname === '/api/v1/__fixture/prefs') return json(ok({ prefs: prefsState.prefs, puts: prefsState.puts }))
    if (url.pathname === '/api/v1/me/profile' && method === 'PATCH') {
      const body = route.request().postDataJSON() ?? {}
      if (typeof overrides.__profileError === 'string') return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { message: overrides.__profileError } }) })
      profile.display_name = String(body.display_name ?? '').trim()
      return json(ok({ display_name: profile.display_name }))
    }
    if (url.pathname === '/api/v1/me/avatar' && method === 'PUT') {
      const bytes = route.request().postDataBuffer() ?? Buffer.alloc(0)
      profileLog.push({ kind: 'avatar-put', size: bytes.length, contentType: route.request().headers()['content-type'] })
      // 是否拒绝由场景用 /__fixture/avatar-reject 切换,而不是检查请求体:
      // Playwright 的 WebKit 读不到二进制请求体(postDataBuffer 为 null),按内容判断会把所有上传都当成假图
      if (profile.rejectAvatar) {
        return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { message: 'invalid input: 只支持 PNG、JPEG、WebP、GIF 图片' } }) })
      }
      profile.avatar = `usr_admin-${(profileLog.length + 0x1000).toString(16).padStart(8, '0')}.png`
      profile.hue = 'green'
      return json(ok({ avatar: profile.avatar }))
    }
    if (url.pathname === '/api/v1/__fixture/avatar-reject') {
      profile.rejectAvatar = route.request().postData() === '1'
      return json(ok({ rejectAvatar: profile.rejectAvatar }))
    }
    if (url.pathname === '/api/v1/me/avatar' && method === 'DELETE') {
      profile.avatar = null
      return json(ok({ avatar: null }))
    }
    // 批量问谁有头像(多人编辑的在线名单);overrides.__userAvatars = { 用户id: 文件名 } 预置别人的头像,
    // 请求记录用 /api/v1/__fixture/avatar-log 读出来(场景据此断言「没头像的人没有产生 404」)
    const userAvatars = overrides.__userAvatars ?? {}
    if (url.pathname === '/api/v1/users/avatars') {
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean)
      avatarLog.push({ kind: 'batch', ids })
      const mine = profile.avatar ? { usr_admin: 'usr_admin-fixture.png' } : {}
      return json(ok({ avatars: Object.fromEntries(ids.map((id) => [id, (userAvatars[id] ?? mine[id]) || null])) }))
    }
    if (url.pathname === '/api/v1/__fixture/avatar-log') return json(ok({ log: avatarLog }))
    const otherAvatar = url.pathname.match(/^\/api\/v1\/users\/([^/]+)\/avatar$/)
    if (otherAvatar && otherAvatar[1] !== 'usr_admin') {
      const id = decodeURIComponent(otherAvatar[1])
      const found = !!userAvatars[id]
      avatarLog.push({ kind: 'image', id, status: found ? 200 : 404 })
      if (!found) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { message: '没有头像' } }) })
      return route.fulfill({ status: 200, contentType: 'image/png', headers: { 'x-content-type-options': 'nosniff' }, body: gradientPng(256, 'green') })
    }
    if (url.pathname === '/api/v1/users/usr_admin/avatar') {
      if (!profile.avatar) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { message: '没有头像' } }) })
      return route.fulfill({ status: 200, contentType: 'image/png', headers: { 'x-content-type-options': 'nosniff' }, body: gradientPng(256, profile.hue) })
    }
    // ---- 数据导出:POST 后进入 running,每轮询一次推进 1/3,第 3 次变 ready
    if (url.pathname === '/api/v1/me/export' && method === 'GET') {
      const job = profile.export
      if (job.state === 'running') {
        job.polls += 1
        if (job.polls >= 3) Object.assign(job, { state: 'ready', size: 4_200_000, files: 7, notes: 12, skipped: ['符号链接,已跳过:old/link.txt'], expires_at: NOW + 23 * 3_600_000 })
      }
      if (job.state === 'idle') return json(ok({ state: 'idle', today_left: job.left }))
      if (job.state === 'running') return json(ok({ state: 'running', bytes_done: Math.floor((job.polls / 3) * 12_000_000), bytes_total: 12_000_000, files: 7, notes: 12 }))
      if (job.state === 'failed') return json(ok({ state: 'failed', reason: job.reason ?? '导出没有成功,请稍后再试' }))
      return json(ok({ state: 'ready', size: job.size, files: job.files, notes: job.notes ?? 0, skipped: job.skipped ?? [], expires_at: job.expires_at }))
    }
    if (url.pathname === '/api/v1/me/export' && method === 'POST') {
      const job = profile.export
      if (job.left <= 0) return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { message: '今天已经导出 3 次了,请明天再试' } }) })
      Object.assign(job, { state: 'running', polls: 0, left: job.left - 1 })
      return json(ok({ state: 'running', bytes_done: 0, bytes_total: 12_000_000, files: 7, notes: 12 }))
    }
    if (url.pathname === '/api/v1/me/export' && method === 'DELETE') {
      Object.assign(profile.export, { state: 'idle', polls: 0 })
      return json(ok({ discarded: true }))
    }
    if (url.pathname === '/api/v1/me/export/download') {
      return route.fulfill({ status: 200, headers: { 'content-type': 'application/gzip', 'content-disposition': 'attachment; filename="usr_admin-0123456789abcdef.tar.gz"', 'cache-control': 'private, no-store' }, body: Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0]) })
    }
    if (url.pathname === '/api/v1/me/email-code' && method === 'POST') {
      const body = route.request().postDataJSON() ?? {}
      // 约定:当前密码 old-password-1;验证码 123456
      if (body.password !== 'old-password-1') return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { message: '密码不正确' } }) })
      profile.pendingEmail = String(body.new_email ?? '').toLowerCase()
      return json(ok({ sent: true, wait_secs: 60, ttl_minutes: 10 }))
    }
    if (url.pathname === '/api/v1/me/email' && method === 'POST') {
      const body = route.request().postDataJSON() ?? {}
      if (body.code !== '123456' || String(body.new_email ?? '').toLowerCase() !== profile.pendingEmail) {
        return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { message: 'invalid input: 验证码不正确,还可以再试 4 次' } }) })
      }
      profile.email = profile.pendingEmail
      return json(ok({ email: profile.email }))
    }
    if (url.pathname === '/api/v1/me/deletion' && method === 'POST') {
      const body = route.request().postDataJSON() ?? {}
      // 约定:当前密码是 old-password-1(和改密码一致)
      if (body.password !== 'old-password-1') return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { message: '密码不正确' } }) })
      profile.deleteAfter = profile.deleteAfter ?? NOW + 7 * 86_400_000
      return json(ok({ delete_after: profile.deleteAfter }))
    }
    if (url.pathname === '/api/v1/me/deletion' && method === 'DELETE') {
      profile.deleteAfter = null
      return json(ok({ cancelled: true }))
    }
    // overrides.__sessionsFail = N:前 N 次读取登录设备返回 500(验证「报错 + 重试」)
    if (url.pathname === '/api/v1/me/sessions' && method === 'GET' && (sessionsFails.n += 1) <= (overrides.__sessionsFail ?? 0)) {
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'internal', message: '登录设备暂时读不出来' } }) })
    }
    if (url.pathname === '/api/v1/me/sessions' && method === 'GET') return json(ok({ sessions }))
    if (url.pathname === '/api/v1/me/sessions/revoke-others' && method === 'POST') {
      const count = sessions.filter((item) => !item.current).length
      sessions = sessions.filter((item) => item.current)
      return json(ok({ revoked: count }))
    }
    const sessionMatch = url.pathname.match(/^\/api\/v1\/me\/sessions\/([0-9a-f]+)$/)
    if (sessionMatch && method === 'DELETE') {
      const target = sessions.find((item) => item.id === sessionMatch[1])
      if (!target) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { message: '这台设备的登录已经失效或不存在' } }) })
      sessions = sessions.filter((item) => item.id !== target.id)
      return json(ok({ revoked: true, current: target.current }))
    }
    // 修改密码已并入下面「公开账号接口」那一段的 change-password 分支
    // 当前用户与功能表:默认是拥有全部功能的管理员;用例用 overrides.__me 换成别的角色 / 关掉 AI
    if (url.pathname === '/api/v1/auth/me') {
      const custom = overrides.__me
      const me = typeof custom === 'function' ? custom() : custom
      if (me) return json(ok(me))
      // 默认用户的头像 / 昵称跟随「个人设置」里的改动,侧栏才会在保存后立刻变
      const user = adminMe()
      user.avatar = profile.avatar
      if (profile.display_name) user.display_name = profile.display_name
      user.delete_after = profile.deleteAfter
      if (profile.deleteAfter !== null) user.status = 'deleting'
      user.email = profile.email
      user.email_verified = true
      return json(ok({ local: false, user }))
    }
    if (url.pathname === '/api/v1/auth/status') {
      // 服务不可用场景:overrides.__authStatusFail = { status, times? } 返回错误状态码(503 维护中 / 500 出错),
      // status 为 'abort' 则直接断开连接(连不上);times 次之后恢复正常,用来验证「自动重试后回到原页面」
      const failure = overrides.__authStatusFail
      if (failure && (failure.times == null || ++authStatusFailures <= failure.times)) {
        if (failure.status === 'abort') return route.abort('connectionfailed')
        return route.fulfill({ status: failure.status, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'unavailable', message: '服务暂时不可用' } }) })
      }
      // 登录 / 注册 / 找回页按站点状态显示不同内容;用例用 overrides.__status 换成别的状态
      const custom = overrides.__status
      const patch = typeof custom === 'function' ? custom() : custom
      return json(ok({
        password_set: true,
        logged_in: true,
        registration_open: true,
        require_invite: false,
        mail_ready: true,
        site: { name: '知识库', tagline: '' },
        ...(patch ?? {}),
      }))
    }
    // 注册 / 找回密码的公开接口:默认全部成功;用例用 overrides.__account(path, body) 返回 {status, body} 模拟失败
    if (/^\/api\/v1\/auth\/(email-code|register|invite-check|password\/reset|change-password)$/.test(url.pathname)) {
      const body = route.request().postDataJSON() ?? {}
      const custom = overrides.__account
      const forced = typeof custom === 'function' ? custom(url.pathname, body) : undefined
      if (forced) {
        return route.fulfill({
          status: forced.status,
          contentType: 'application/json',
          headers: forced.headers ?? {},
          body: JSON.stringify(forced.status < 300 ? { ok: true, data: forced.body } : { ok: false, error: forced.body }),
        })
      }
      if (url.pathname.endsWith('/email-code')) return json(ok({ sent: true, wait_secs: 60, ttl_minutes: 10 }))
      // 只有以 KB-7H2K 开头的邀请码算有效,其余(格式完整但不存在)返回无效
      if (url.pathname.endsWith('/invite-check')) return json(ok({ valid: String(body.invite ?? '').toUpperCase().startsWith('KB-7H2K'), reason: '邀请码无效、已过期或已用完' }))
      if (url.pathname.endsWith('/register')) return json(ok({ registered: true, logged_in: true, username: body.username }))
      if (url.pathname.endsWith('/change-password')) {
        // 约定:当前密码是 old-password-1,其它都算不对(场景用它测错误提示)
        if (body.old_password !== 'old-password-1') return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { message: 'invalid input: 旧密码不正确' } }) })
        sessions = sessions.filter((item) => item.current)
        return json(ok({ changed: true }))
      }
      return json(ok({ reset: true }))
    }
    if (url.pathname === '/api/v1/auth/login') {
      // 用例用 overrides.__login(body) 返回 {status, body, headers} 模拟「还要验证码」「密码错」「限速」等
      const custom = overrides.__login
      const forced = typeof custom === 'function' ? custom(route.request().postDataJSON() ?? {}) : undefined
      if (forced) {
        return route.fulfill({
          status: forced.status,
          contentType: 'application/json',
          headers: forced.headers ?? {},
          body: JSON.stringify(forced.status < 300 ? { ok: true, data: forced.body } : { ok: false, error: forced.body }),
        })
      }
      return json(ok({ logged_in: true }))
    }
    // ---- 两步验证:状态 / 设置 / 确认 / 关闭 / 重新生成恢复码 / 登录那一步
    if (url.pathname === '/api/v1/auth/login/totp' || /^\/api\/v1\/auth\/totp(\/(setup|confirm|disable|recovery))?$/.test(url.pathname)) {
      const body = method === 'POST' ? (route.request().postDataJSON() ?? {}) : {}
      totp.calls.push({ method, path: url.pathname, body, csrf: route.request().headers()['x-kb-csrf'] })
      const fail = (status, code, message) => route.fulfill({ status, contentType: 'application/json', headers: status === 429 ? { 'retry-after': '900' } : {}, body: JSON.stringify({ ok: false, error: { code, message } }) })
      const codeOk = (code) => {
        const text = String(code ?? '').replace(/[\s-]/g, '').toUpperCase()
        if (text === '123456') return true
        const recovery = TOTP_RECOVERY(totp.generation).find((item) => item.replace(/-/g, '') === text)
        if (!recovery || totp.used.has(recovery)) return false
        totp.used.add(recovery)
        totp.left = Math.max(0, totp.left - 1)
        return true
      }
      if (url.pathname === '/api/v1/auth/login/totp') {
        if (body.challenge === 'chal-expired') return fail(401, 'challenge_expired', '登录已超时,请重新输入密码')
        if (body.challenge !== 'chal-1') return fail(401, 'challenge_expired', '登录已超时,请重新输入密码')
        if (body.code === '429429') return fail(429, 'rate_limited', '验证码输错次数过多,请 15 分钟后再试,或用恢复码登录')
        if (!codeOk(body.code)) return fail(401, 'bad_code', '验证码不正确或已经用过')
        return json(ok({ logged_in: true }))
      }
      if (url.pathname === '/api/v1/auth/totp') {
        if (overrides.__totp?.status) return fail(overrides.__totp.status, overrides.__totp.status === 403 ? 'forbidden' : 'internal', overrides.__totp.status === 403 ? '只有在浏览器里登录后才能设置两步验证' : '服务暂时不可用')
        return json(ok({ enabled: totp.enabled, recovery_codes_left: totp.enabled ? totp.left : 0, required: totp.required }))
      }
      if (url.pathname.endsWith('/setup')) {
        if (body.password !== 'old-password-1') return fail(401, 'bad_password', '密码不正确')
        if (totp.enabled) return fail(409, 'conflict', '两步验证已经开启')
        return json(ok({ secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', otpauth_uri: 'otpauth://totp/%E7%9F%A5%E8%AF%86%E5%BA%93:admin%40example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=%E7%9F%A5%E8%AF%86%E5%BA%93&algorithm=SHA1&digits=6&period=30', issuer: '知识库' }))
      }
      if (url.pathname.endsWith('/confirm')) {
        if (body.code === '429429') return fail(429, 'rate_limited', '验证码输错次数过多,请 15 分钟后再试,或用恢复码登录')
        if (body.code !== '123456') return fail(401, 'bad_code', '验证码不正确,请检查手机时间是否准确')
        totp.enabled = true
        totp.left = 8
        totp.generation += 1
        totp.used.clear()
        return json(ok({ enabled: true, recovery_codes: TOTP_RECOVERY(totp.generation) }))
      }
      if (url.pathname.endsWith('/disable')) {
        if (totp.required) return fail(403, 'totp_required', '站点要求管理员必须开启两步验证,不能关闭')
        if (body.password !== 'old-password-1') return fail(401, 'bad_password', '密码不正确')
        if (body.code === '429429') return fail(429, 'rate_limited', '验证码输错次数过多,请 15 分钟后再试,或用恢复码登录')
        if (!codeOk(body.code)) return fail(401, 'bad_code', '验证码不正确或已经用过')
        totp.enabled = false
        return json(ok({ enabled: false }))
      }
      // recovery
      if (body.password !== 'old-password-1') return fail(401, 'bad_password', '密码不正确')
      if (!codeOk(body.code)) return fail(401, 'bad_code', '验证码不正确或已经用过')
      totp.generation += 1
      totp.left = 8
      totp.used.clear()
      return json(ok({ recovery_codes: TOTP_RECOVERY(totp.generation) }))
    }
    if (url.pathname === '/api/v1/__fixture/totp') return json(ok({ calls: totp.calls, enabled: totp.enabled }))
    // ---- 个人访问令牌
    if (url.pathname === '/api/v1/auth/tokens' && method === 'POST') {
      const body = route.request().postDataJSON() ?? {}
      tokenState.calls.push({ method, body, csrf: route.request().headers()['x-kb-csrf'] })
      if (overrides.__tokenCreate) {
        const forced = overrides.__tokenCreate(body)
        if (forced) return route.fulfill({ status: forced.status, contentType: 'application/json', body: JSON.stringify({ ok: false, error: forced.body }) })
      }
      const row = { id: `kbt_new${tokenState.created.length + 1}`, name: body.name, scope: body.scope ?? 'mcp', scopes: body.scope ?? 'mcp', include_shared: (body.scope ?? 'mcp') === 'mcp' && body.include_shared === true, created_at: NOW, last_used: null, revoked_at: null }
      tokenState.created.push(row)
      // 与后端一致:创建响应只有 id / name / scope / token(明文只此一次),include_shared 要等列表才看得到
      return json(ok({ id: row.id, name: row.name, scope: row.scope, token: `kb_${'a1b2c3d4e5f6a7b8'.repeat(4)}` }))
    }
    const tokenMatch = url.pathname.match(/^\/api\/v1\/auth\/tokens\/([^/]+)$/)
    if (tokenMatch && method === 'DELETE') {
      tokenState.calls.push({ method, id: tokenMatch[1], csrf: route.request().headers()['x-kb-csrf'] })
      tokenState.revoked.set(tokenMatch[1], NOW)
      return json(ok({ id: tokenMatch[1], revoked_at: NOW }))
    }
    if (url.pathname === '/api/v1/__fixture/tokens') return json(ok({ calls: tokenState.calls }))
    if (url.pathname === '/api/v1/auth/tokens') {
      if (overrides.__tokensFail) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'internal', message: '令牌服务暂时不可用' } }) })
      // 旧夹具的令牌是给系统设置页用的(scopes 字段);补上后端真实返回的 scope / include_shared
      const base = overrides.__tokens ?? tokens.map((item) => ({ ...item, scope: /^mcp/.test(item.scopes) ? 'mcp' : 'api', include_shared: false }))
      return json(ok({ tokens: [...base, ...tokenState.created].map((item) => (tokenState.revoked.has(item.id) ? { ...item, revoked_at: tokenState.revoked.get(item.id) } : item)) }))
    }
    if (url.pathname === '/api/v1/health') {
      return json(ok({ status: 'ok', version: '0.4.0' }))
    }
    const name = url.pathname.match(/\/capabilities\/([a-zA-Z_]+)/)?.[1]
    // 通知列表失败:用例用 overrides.__notificationsFail = 状态码 让 notification_list 返回错误,验证抽屉的「报错 + 重试」
    if (name === 'notification_list' && overrides.__notificationsFail) {
      return route.fulfill({ status: overrides.__notificationsFail, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: overrides.__notificationsFail === 403 ? 'forbidden' : 'internal', message: overrides.__notificationsFail === 403 ? 'forbidden: 没有权限' : 'internal: sqlite busy' } }) })
    }
    // 用例用 overrides.__capabilityError = { 能力名: { status, message, code?, times? } } 让某个能力失败(报错 / 无权限状态);
    // times = 只失败前 N 次,之后恢复正常(测「报错后点重试」)。计数按浏览器上下文记,场景之间互不影响。
    const forcedFailure = name ? overrides.__capabilityError?.[name] : undefined
    if (forcedFailure) {
      const seen = failureSeen.get(context) ?? {}
      failureSeen.set(context, seen)
      seen[name] = (seen[name] ?? 0) + 1
      if (forcedFailure.times === undefined || seen[name] <= forcedFailure.times) {
        return route.fulfill({ status: forcedFailure.status, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: forcedFailure.code ?? 'internal', message: forcedFailure.message } }) })
      }
    }
    if (name === 'notification_list' && overrides.notification_list === undefined) {
      const args = route.request().postDataJSON() ?? {}
      let list = notifState.items.slice().sort((a, b) => Number(b.id) - Number(a.id))
      if (args.unread_only) list = list.filter((item) => !item.read_at)
      if (args.before_id !== undefined && args.before_id !== null) list = list.filter((item) => Number(item.id) < Number(args.before_id))
      const limit = Number(args.limit ?? 30)
      const page = list.slice(0, limit)
      return json(ok({ notifications: page, unread: unreadOf(), next_before_id: list.length > limit ? page[page.length - 1].id : null }))
    }
    if (name === 'notification_read' && overrides.notification_read === undefined) {
      const args = route.request().postDataJSON() ?? {}
      notifState.reads.push(args)
      const ids = new Set((args.ids ?? []).map(String))
      for (const item of notifState.items) if ((args.all || ids.has(String(item.id))) && !item.read_at) item.read_at = NOW
      return json(ok({ unread: unreadOf() }))
    }
    if (name && social) {
      const reply = social.handle(name, route.request().postDataJSON() ?? {})
      if (reply) {
        if (name === 'friend_list' && social.delay()) await new Promise((resolve) => setTimeout(resolve, social.delay()))
        if (reply.error) return route.fulfill({ status: reply.error.status, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: reply.error.code, message: reply.error.message } }) })
        return json(ok(reply.data))
      }
    }
    // 测试钩子:读出社交假后端收到的写操作
    if (url.pathname === '/api/v1/__fixture/social') return json(ok({ log: social?.log ?? [], state: social?.state ?? null }))
    // 测试钩子:读出夹具里通知被标记已读的记录
    if (url.pathname === '/api/v1/__fixture/notifications') return json(ok({ reads: notifState.reads, unread: unreadOf() }))
    if (name) {
      // 测试钩子:overrides.__hold = { 能力名: 毫秒 } 让这个能力的回答晚一会儿再回(例如助手一轮对话还没结束时,推一条排队事件)
      const hold = overrides.__hold?.[name]
      if (hold) await new Promise((resolve) => setTimeout(resolve, hold))
      const override = overrides[name]
      if (override !== undefined) {
        return json(ok(typeof override === 'function' ? override(route.request().postDataJSON() ?? {}) : override))
      }
      const dynamic = dynamicResponses[name]
      if (dynamic) return json(ok(dynamic(route.request().postDataJSON() ?? {})))
      const data = responses[name] ?? {}
      return json(ok(data))
    }
    // ---- Office 在线编辑：编辑权 / 冲突 / 整份字节替换。真实实现见 api/officeEdit.ts
    if (url.pathname === '/api/v1/files/lock' && method === 'POST') {
      const body = route.request().postDataJSON() ?? {}
      officeEdit.locks.push({ session: body.session, takeOver: !!body.take_over })
      if (!officeEdit.held) {
        return json(ok({ held: false, ttl_secs: 45, same_user: false, holder: { actor: '另一位同事', session: 's-other', since_ms: Date.now() - 60_000, idle_secs: 3 } }))
      }
      return json(ok({ held: true, ttl_secs: 45 }))
    }
    if (url.pathname === '/api/v1/files/lock' && method === 'DELETE') return json(ok({ released: true }))
    if (url.pathname === '/api/v1/office/session') {
      // 协同场景显式给出房间底稿；默认仍然是「这个环境没有协同服务」的单人编辑
      const collab = overrides.__officeSession
      if (collab) return json(ok(typeof collab === 'function' ? collab(route.request().postDataJSON() ?? {}) : collab))
      return json(ok({ mode: 'single', reason: '（夹具）这个环境没有协同服务' }))
    }
    if (url.pathname === '/api/v1/office/seed') {
      // docx 房间的初始状态（服务端副本的状态）：场景用 __officeSeed 给；两个浏览器必须拿到同一份，才能汇合
      const seed = typeof overrides.__officeSeed === 'function' ? await overrides.__officeSeed() : null
      if (!seed) return route.fulfill({ status: 404, body: 'missing office seed' })
      return route.fulfill({ status: 200, contentType: 'application/octet-stream', body: Buffer.from(seed) })
    }
    if (url.pathname === '/api/v1/office/base') {
      // docx 协同：场景用 __officeBase 给底稿字节（房间里的所有人从同一份字节起步）
      if (overrides.__officeBase) return route.fulfill({ status: 200, contentType: SAMPLE_TYPES.docx, body: Buffer.from(await overrides.__officeBase()) })
      // 协同底稿按内容寻址；夹具用同一份 sample.xlsx，两个浏览器才能从相同字节汇合
      // 按文档引用里的扩展名选样本(pptx 协同用 KB_SAMPLE_PPTX 指定的 deck);没有扩展名线索时保持原来的 xlsx
      const docExt = /\.(pptx|docx|xlsx)$/i.exec(url.searchParams.get('doc') ?? '')?.[1]?.toLowerCase() ?? 'xlsx'
      const sample = sampleFor(`sample.${docExt}`)
      if (!sample) return route.fulfill({ status: 404, body: `missing sample.${docExt}` })
      return route.fulfill({ status: 200, contentType: SAMPLE_TYPES[docExt], body: sample.body })
    }
    if (url.pathname === '/api/v1/files/roundtrip-check' && method === 'POST') {
      // 打开编辑时「不改直接保存」的字节留给场景核对(例如与原件逐部件相同)；
      // 场景可传 __officeEdit.roundtrip(resavedBytes) 用真实比较作答（18 份真实文档的无损检查用），
      // 也可往 __officeEdit.roundtripReport 里放固定的不无损报告；都不传就一律回"无损"，其它场景不关心这一步
      officeEdit.roundtrips ??= []
      const resaved = route.request().postDataBuffer() ?? Buffer.alloc(0)
      officeEdit.roundtrips.push({ bytes: resaved.length, body: resaved })
      if (officeEdit.roundtrip) return json(ok(await officeEdit.roundtrip(resaved)))
      return json(ok(officeEdit.roundtripReport ?? { lossless: true, valid: true, text_equal: true, changed_parts: [], removed_parts: [], added_parts: [], reason: null }))
    }
    if (url.pathname === '/api/v1/files/replace' && method === 'PUT') {
      const body = route.request().postDataBuffer() ?? Buffer.alloc(0)
      officeEdit.replaces.push({
        expected: url.searchParams.get('expected_sha256'),
        session: url.searchParams.get('session'),
        bytes: body.length,
        zip: body.subarray(0, 2).toString('latin1') === 'PK',
        // 留下整份字节，场景里解压后检查（document.xml 里命令是否真的写进了文件、保存后哪些 slide XML 变了）
        body,
      })
      if (officeEdit.conflict) {
        return json({ ok: false, error: { code: 'sha_mismatch', message: '文件已被别人修改，请重新打开再改' } }, 409)
      }
      return json(ok({ version: 9, sha256: 'sha-fixture-edited', unchanged: false, embedded: 0, parts_removed: [] }))
    }
    // 分片上传(笔记附件用):建会话 → 收分片 → 完成;完成时把 rel_path 原样返回
    if (url.pathname === '/api/v1/uploads' && route.request().method() === 'POST') {
      const body = route.request().postDataJSON() ?? {}
      const id = `up_${Math.random().toString(36).slice(2, 10)}`
      uploadSessions.set(id, body)
      return json(ok({ upload_id: id, state: 'pending', batch_id: 'b1', name: body.name, rel_path: body.rel_path, chunk_size: 8 * 1024 * 1024, parts_total: Math.max(1, Math.ceil((body.size ?? 1) / (8 * 1024 * 1024))), received: [], received_bytes: 0, dedup: 'new', existing: null }))
    }
    const partMatch = url.pathname.match(/^\/api\/v1\/uploads\/([^/]+)\/parts\/(\d+)$/)
    if (partMatch) return json(ok({ part_no: Number(partMatch[2]), size: 0, sha256: '' }))
    const completeMatch = url.pathname.match(/^\/api\/v1\/uploads\/([^/]+)\/complete$/)
    if (completeMatch) {
      const session = uploadSessions.get(completeMatch[1]) ?? {}
      return json(ok({ upload_id: completeMatch[1], batch_id: 'b1', collection: session.collection, files: [{ id: 'f1', rel_path: session.rel_path, state: 'queued' }], skipped: [], job_id: 'j1' }))
    }
    if (url.pathname === '/api/v1/uploads/precheck') {
      // 上传预检:默认都是新文件;故事里可以用 `__precheck(body)` 指定哪些重复
      const body = route.request().postDataJSON() ?? { files: [] }
      const results = overrides.__precheck
        ? overrides.__precheck(body)
        : (body.files ?? []).map((file) => ({ ...file, status: 'new', existing: null }))
      return json(ok({ results }))
    }
    return json(ok({}))
  })
  // 场景要在通用拦截之上再叠一层专属的假接口(例如分享的带状态假后端,见 share-fixture.mjs):
  // 后注册的路由先匹配,所以放在最后;每个上下文各调用一次,状态互不串。
  if (typeof overrides.__after === 'function') await overrides.__after(context)
}

/* ---------------------------------------------------------------------------
 * 任务审计页的“剧情”:设计稿里的当前时间是 00:25:20(日志最后一行 00:25:11),
 * 与仪表盘设计稿的 00:42 不是同一时刻——按页面各自带一份数据与时钟。
 * ------------------------------------------------------------------------- */
export const jobsStoryNow = sh(10, 21, 0, 25, 20)
const job = (id, kind, collection, state, done, total, detail, startedAt, tookSec, extra = {}) => ({
  id, kind, collection, state, progress_done: done, progress_total: total, rate: null, error: null, detail,
  created_at: (startedAt ?? jobsStoryNow) - 20_000, started_at: startedAt, finished_at: startedAt && tookSec ? startedAt + tookSec * 1000 : null, ...extra,
})
const batch = (id, actor, description, protocol, changes, minutesAgo) => ({
  id, actor, description, protocol, created_at: jobsStoryNow - minutesAgo * MINUTE, reverted_at: null,
  changes: changes.map(([op, revertible], index) => ({ seq: index + 1, target: `t${index}`, op, revertible })),
})
export const jobsStory = {
  job_list: {
    jobs: [
      job('job_4412', 'reindex', 'SampleApp/docs', 'running', 64, 100, 'bge-m3 · 912 块', sh(10, 21, 0, 22, 10), 0),
      job('job_4413', 'evolve', 'knowledgeBase', 'queued', 0, null, 'diff 3da960b..HEAD', null, 0),
      job('job_4414', 'eval', 'knowledgeBase', 'queued', 0, null, 'eval/kb-core.jsonl', null, 0),
      job('job_4409', 'embed', 'sampleproj/docs', 'failed', 37, 100, null, sh(10, 21, 0, 12, 0), 41, { error: 'sidecar timeout · 重试 1/3' }),
      job('job_4408', 'ingest', 'sampleproj/code', 'done', 100, 100, '+214 −18 文件', sh(10, 21, 0, 8, 0), 52),
      job('job_4405', 'evolve', 'SampleApp', 'done', 5, 5, '2 候选 · 1 skipped_fingerprint', sh(10, 21, 0, 2, 0), 64),
      job('job_4401', 'backup', null, 'done', 1, 1, '182 MB', sh(10, 21, 0, 0, 0), 12),
      job('job_4398', 'eval', 'knowledgeBase', 'done', 1, 1, 'hit@5 1.00 · MRR 0.927', sh(10, 20, 23, 10, 0), 158),
    ].map((entry) => (entry.collection === null ? { ...entry, collection: null } : entry)),
  },
  batch_list: {
    total: 192,
    page_size: 20,
    offset: 0,
    batches: [
      batch('bat_0192', 'mcp · Claude Code', 'kb_add_insight ×3', '2025-06-18', [['insight.create', true]], 5),
      batch('bat_0191', 'web · admin', '删除 ins_7a11 · 不再提炼', null, [['insight.delete', true]], 9),
      batch('bat_0190', 'cli · ds-executor', 'ingest sampleproj/code', null, [['ingest', false]], 17),
      batch('bat_0189', 'mcp · Codex', 'kb_search ×12', '2025-03-26', [], 30),
      batch('bat_0188', 'mcp · Kiro', 'kb_get_insight ×4', '2025-11-25', [], 41),
      batch('bat_0187', 'web · admin', '驳回 drf_4f2', null, [['draft.reject', true]], 60),
      batch('bat_0186', 'evolve · auto', 'promote ins_8e07', null, [['insight.promote', false]], 90),
      batch('bat_0185', 'cli · dev', 'kb reindex SampleApp/docs', null, [['reindex', false]], 120),
    ],
  },
  system_status: {
    ...systemStatus,
    logs: {
      dir: '~/.kb/logs',
      files: [],
      diagnostics: [],
      tail: [
        '00:22:04 INFO reindex start collection=SampleApp/docs embedder=bge-m3',
        '00:22:05 INFO  batch 1/15 · 64 chunks · iGPU 41 ms/batch',
        '00:22:00 INFO  batch 2/15 · 64 chunks · 38 ms/batch',
        '00:22:17 INFO  batch 3/15 · 64 chunks · 39 ms/batch',
        '00:22:34 INFO  batch 4/15 · 64 chunks · 40 ms/batch',
        '00:23:51 INFO  batch 5/15 · 64 chunks · 41 ms/batch',
        '00:23:08 INFO  batch 6/15 · 64 chunks · 42 ms/batch',
        '00:23:25 INFO  batch 7/15 · 64 chunks · 38 ms/batch',
        '00:24:42 INFO  batch 8/15 · 64 chunks · 39 ms/batch',
        '00:23:40 WARN  chunk doc_0441 truncated 8192→8000 tokens',
        '00:25:11 INFO  batch 9/15 · eta 1m 48s',
      ],
    },
  },
}

/* ---------------------------------------------------------------------------
 * 项目与集合页的剧情:集合清单与迁移中的 SampleApp/code(41%)
 * ------------------------------------------------------------------------- */
const projectStoryCollections = [
  ['knowledgeBase/code', 'code', 3112, 'kb_code__bgem3i8_v2', null],
  ['knowledgeBase/docs', 'docs', 214, 'kb_docs__bgem3i8_v1', null],
  ['knowledgeBase/insights', 'ins', 482, 'kb_ins__bgem3i8_v1', null],
  ['SampleApp/code', 'code', 4206, 'ck_code__bgem3i8_v1', 'fastembed:bge-m3-q8'],
  ['_global/外部资料', 'ext', 1206, 'glb_ext__bgem3i8_v1', null],
  ['sampleproj/code', 'code', 2530, 'nt_code__bgem3i8_v1', null],
].map(([name, , rows, table, to]) => ({ name, kind: 'project', project_id: 'p1', embedder_id: 'fastembed:bge-m3-int8', dim: 1024, active_table: table, rows, migrating_to: to }))
export const projectsStory = {
  list_collections: { collections: projectStoryCollections },
  list_projects: {
    projects: [
      { project: { ...fixture.projects[1].project, include: ['src/**', 'docs/**'], exclude: ['target/**', 'web-ui/node_modules/**'] }, collection: 'proj_knowledgebase', rows: 4800, items: 600 },
      { project: { ...fixture.projects[0].project, include: ['**/*'], exclude: ['build/**'], allow_cloud_llm: false, extract_enabled: true }, collection: 'proj_sampleapp', rows: 5100, items: 637 },
      { project: { ...fixture.projects[2].project, include: ['**/*'], exclude: [], extract_enabled: false, hooks_installed: false }, collection: 'proj_sampleproj', rows: 2500, items: 312 },
    ],
  },
  job_list: {
    jobs: [
      { id: 'job_mig', kind: 'migrate', collection: 'SampleApp/code', state: 'running', progress_done: 41, progress_total: 100, rate: null, error: null, created_at: NOW - 6 * MINUTE, started_at: NOW - 5 * MINUTE, finished_at: null },
    ],
  },
}

/* ---------------------------------------------------------------------------
 * 生产实况(用户截图):组件“已选用但本机缺运行时”、文案很长。
 * 用来复现 / 回归“文字重叠、当前 + 未安装互相矛盾”这类问题。
 * ------------------------------------------------------------------------- */
const prodComponents = [
  { kind: 'ocr', id: 'rapidocr', name: 'RapidOCR(PP-OCRv6) · PP-OCRv6 small · /home/user/.codeg/.cache/kb-models/ocr/ppocrv6', installed: false, ready: false, current: true, detail: '找不到命令 rapidocr;装 rapidocr-onnxruntime 或指向薄封装脚本', model: null, install_command: 'pip install rapidocr-onnxruntime', removable: false },
  { kind: 'ocr', id: 'tesseract', name: 'tesseract', installed: false, ready: false, current: false, detail: '找不到命令 tesseract;装上 tesseract 即可作为降级后端', model: null, install_command: 'apt-get install tesseract-ocr', removable: false },
  { kind: 'transcribe', id: 'whisper-cli', name: 'whisper-cli', installed: false, ready: false, current: true, detail: '找不到命令 whisper-cli;装上 whisper.cpp 或指向薄封装脚本', model: null, install_command: 'bash install-whisper.sh', removable: false },
  { kind: 'embed', id: 'bge-m3-int8', name: 'bge-m3-int8 · 后端 fastembed · 单块 512 token', installed: true, ready: false, current: true, detail: '模型目录 /home/user/.codeg/.cache/kb-models/bge-m3-int8 不存在', model: null, install_command: null, removable: false },
  { kind: 'rerank', id: 'http-rerank', name: 'http://127.0.0.1:18082/v1/rerank · 候选 20 条 · 预算 3000 ms', installed: true, ready: true, current: true, detail: '就绪', model: null, install_command: null, removable: false },
]
export const prodStory = {
  system_status: {
    ...systemStatus,
    overview: { ...systemStatus.overview, components_ready: [1, 5] },
    components: prodComponents,
    network: { ...systemStatus.network, socket: '/srv/kb/run/kb.sock', listen: '127.0.0.1:18600', mcp_sessions: undefined },
  },
  provider_list: { providers: prodComponents, env: { ...systemStatus.env, gpu: 'Intel 核显(/dev/dri)', tools: [], memory_mb: 64036, cpu_cores: 16 } },
  recommend_providers: {
    recommendations: [
      { kind: 'ocr', provider: 'rapidocr', reason: '没有独显,CPU 推理:RapidOCR small 精度接近同代 Paddle,内存占用低', already_current: true },
      { kind: 'transcribe', provider: 'whisper-cli', reason: '未检测到 whisper.cpp;转写保持关闭(不影响入库)', already_current: false },
    ],
  },
  stats_overview: { ...stats, totals: { rows: 0, items: 0, insights: 0, projects: 0 }, drafts_pending: 0, collections: [], jobs: { queued: 0, running: 0, paused: 0, done: 0, failed: 0, canceled: 0 }, activity_7d: [], recent_events: [], trends: undefined },
  list_projects: { projects: [] },
  list_collections: { collections: [] },
  list_sources: { sources: [] },
  job_list: { jobs: [] },
  audit_list: { entries: [], total: 0, page_size: 20, offset: 0 },
  batch_list: { batches: [], total: 0, page_size: 20, offset: 0 },
  eval_history: { runs: [] },
}

/* ---------------------------------------------------------------------------
 * 数据源设计稿的剧情:6 个数据源 + 文件处理汇总(总数 13,912 / 待解析 37 / 失败 2 / 隔离 1)
 * ------------------------------------------------------------------------- */
const src = (id, kind, name, uri, files, status, collection, last, extra = {}) => ({ id, kind, name, uri, collection, tags: [], include: [], exclude: [], depth: 0, allow_hosts: [], refresh_minutes: null, status, last_synced_at: last, last_error: null, files, created_at: NOW - 30 * DAY, ...extra })
const srcStats = (total, today, failed, quarantined, pending) => ({ total, today, failed, quarantined, pending })
const sourcesStorySources = [
  src('s1', 'local_dir', 'knowledgeBase', '/srv/kb', 4812, 'idle', 'knowledgeBase/code', NOW - 2 * MINUTE),
  src('s2', 'git', 'SampleApp', 'git@github.com:dev/sampleapp.git', 5104, 'idle', 'SampleApp/code', NOW - 18 * MINUTE, { refresh_minutes: 60 }),
  src('s3', 'web', 'Rust 异步手册', 'https://rust-lang.github.io/async-book/', 214, 'syncing', '_global', NOW, { depth: 2, refresh_minutes: 10080 }),
  src('s4', 'upload', '论文与报告', '上传 · 46 个文件', 46, 'error', '_global', NOW - 20 * HOUR),
  src('s5', 'archive', 'Confluence 导出', 'space-ENG.zip · 38 MB', 1206, 'idle', '_global', NOW - DAY),
  src('s6', 'local_dir', 'sampleproj', '/srv/sampleproj', 2530, 'idle', 'sampleproj/code', NOW - HOUR),
]
// 每个源的解析队列计数(后端 list_sources.items[].stats 的形状)
const sourcesStoryStats = {
  s1: srcStats(4812, 128, 0, 0, 6),
  s2: srcStats(5104, 0, 0, 0, 0),
  s3: srcStats(214, 12, 0, 0, 9),
  s4: srcStats(46, 0, 2, 0, 0),
  s5: srcStats(1206, 0, 0, 1, 0),
  s6: srcStats(2530, 0, 0, 0, 3),
}
export const sourcesStory = {
  list_sources: {
    sources: sourcesStorySources,
    items: sourcesStorySources.map((source) => ({ source, stats: sourcesStoryStats[source.id] ?? null })),
  },
  // 拖放区说明里的单文件上限 + 格式覆盖里的 OCR / 转写后端(设计稿:2 GB、都已就绪)
  get_config: { ...config, upload: { max_file_mb: 2048 } },
  system_status: {
    ...systemStatus,
    components: [
      { kind: 'ocr', id: 'rapidocr', name: 'RapidOCR', installed: true, ready: true, current: true, detail: null, model: null, install_command: '', removable: false },
      { kind: 'transcribe', id: 'whisper', name: 'whisper', installed: true, ready: true, current: true, detail: null, model: null, install_command: '', removable: false },
    ],
  },
  list_ingest: (args) => {
    const totals = { queued: 20, extracting: 9, chunking: 5, embedding: 3, failed: 2, quarantined: 1 }
    const total = args?.state ? (totals[args.state] ?? 0) : 13912
    return { files: [], total, page: 1, page_size: args?.page_size ?? 50 }
  },
}

/** 数据源页 · 重复文件:前 4 个文件与设计稿同名同情况,其余都是新文件 */
const dupStatus = {
  '向量检索综述-2025.pdf': 'same_content',
  '季度架构评审.docx': 'same_name_diff_content',
  '模型评测.xlsx': 'same_name_diff_content',
  '截图 2026-10-21 14.02.png': 'same_content',
}
export const sourcesDuplicatesStory = {
  ...sourcesStory,
  __precheck: (body) =>
    (body.files ?? []).map((file) => {
      const status = dupStatus[file.rel_path] ?? 'new'
      return { ...file, status, existing: status === 'new' ? null : { id: `ing_${file.rel_path}`, rel_path: file.rel_path, size: file.size, state: 'done' } }
    }),
}

/** 上传与解析队列(11):与设计稿同一批 10 个文件,批次 bat_0c71…(取前 8 位显示) */
const BATCH = 'bat_0c71-6d1e-7f3a-92b4-5a8c1e07d3aa'
const ing = (n, rel, size, state, extra = {}) => ({
  id: `ing_${n}`, batch_id: BATCH, source_id: 's4', collection: '_global', rel_path: rel, size, state,
  error: null, chunks: 0, vectors: 0, elapsed_ms: null, ...extra,
})
const MB = 1024 * 1024
export const ingestStory = {
  ...sourcesStory,
  list_ingest: {
    total: 10,
    page: 1,
    page_size: 200,
    files: [
      ing(1, '向量检索综述-2025.pdf', 4.2 * MB, 'done', { chunks: 186, vectors: 186, elapsed_ms: 1800, extract_meta: JSON.stringify({ pages: 42 }) }),
      ing(2, '季度架构评审.docx', 0.86 * MB, 'done', { chunks: 64, vectors: 64, elapsed_ms: 600, extract_meta: JSON.stringify({}) }),
      ing(3, '产品路线图 Q4.pptx', 12.6 * MB, 'extracting', { extract_meta: JSON.stringify({ slides: 28 }) }),
      ing(4, '模型评测-合并单元格.xlsx', 0.3 * MB, 'embedding', { extract_meta: JSON.stringify({ sheets: 3 }) }),
      ing(5, '白板-架构草图.png', 1.1 * MB, 'queued', { extract_meta: JSON.stringify({ pages: 1, needs_ocr: true }) }),
      ing(6, '周会录音-10-20.m4a', 48 * MB, 'queued'),
      ing(7, '扫描件-合同-2019.pdf', 3.4 * MB, 'failed', { error: 'OCR 模型未下载 · kb accel ocr install', elapsed_ms: 12400 }),
      ing(8, 'Designing Data-Intensive Apps.epub', 9.8 * MB, 'failed', { error: 'DRM 加密，无法解析', elapsed_ms: 200 }),
      ing(9, 'space-ENG.zip › attachments/dump.sql', 1.9 * 1024 * MB, 'quarantined', { source_id: 's5', error: '超过单文件上限 512 MB' }),
      ing(10, 'RE: 迁移方案评审.eml', 0.2 * MB, 'done', { source_id: 's5', chunks: 9, vectors: 9, elapsed_ms: 300 }),
    ],
  },
  get_batch_progress: {
    batch: BATCH, collection: '论文与报告', state: 'running', stage: 'embed', done: 6, total: 10, chunks: 1412, vectors: 1024,
    throughput_cps: 46.8, eta_s: 100, elapsed_s: 192, current_files: ['产品路线图 Q4.pptx', '模型评测-合并单元格.xlsx', '白板-架构草图.png'], backend: '核显 Vulkan · bge-m3 Q8_0',
    stages: [
      { stage: 'upload', label: '上传', files: 10, done: 10, chunks: 0, vectors: 0, percent: 100 },
      { stage: 'detect', label: '类型识别', files: 10, done: 10, chunks: 0, vectors: 0, percent: 100 },
      { stage: 'extract', label: '解析 / 抽取', files: 10, done: 7, chunks: 0, vectors: 0, percent: 70 },
      { stage: 'chunk', label: '分块', files: 10, done: 6, chunks: 1412, vectors: 0, percent: 60 },
      { stage: 'embed', label: '向量化', files: 10, done: 5, chunks: 1412, vectors: 1038, percent: 73 },
      { stage: 'write', label: '写入索引', files: 10, done: 5, chunks: 1412, vectors: 1024, percent: 72 },
      { stage: 'searchable', label: '可检索', files: 10, done: 5, chunks: 0, vectors: 0, percent: 50 },
    ],
  },
  get_file_timeline: {
    file: { ...ing(7, '扫描件-合同-2019.pdf', 18.6 * MB, 'failed', { error: 'OCR 模型未下载 · kb accel ocr install', elapsed_ms: 12200 }), sha256: '8a5d8b28d66ae90b5876fe0337b963d9f66ab1047f8c866ff4646b73a8a3aa41' },
    total_ms: 12200,
    stages: [
      { stage: 'upload', label: '上传', status: 'ok', duration_ms: 400, chunks: 0, vectors: 0, error: null },
      { stage: 'detect', label: '类型识别', status: 'ok', duration_ms: 2, chunks: 0, vectors: 0, error: null },
      { stage: 'extract', label: '解析 / 抽取', status: 'failed', duration_ms: 11800, chunks: 0, vectors: 0, error: '42 页中 3 页无文字层 → OCR 失败' },
      { stage: 'chunk', label: '分块', status: 'pending', duration_ms: null, chunks: 0, vectors: 0, error: null },
      { stage: 'embed', label: '向量化', status: 'pending', duration_ms: null, chunks: 0, vectors: 0, error: null },
      { stage: 'write', label: '写入索引', status: 'pending', duration_ms: null, chunks: 0, vectors: 0, error: null },
    ],
  },
}

/** 批次已完成(批次完成):7 成功 / 2 失败 / 1 隔离,总用时 4 分 52 秒 */
export const ingestDoneStory = {
  ...ingestStory,
  list_ingest: {
    ...ingestStory.list_ingest,
    files: ingestStory.list_ingest.files.map((file) =>
      ['failed', 'quarantined', 'done'].includes(file.state)
        ? file
        : { ...file, state: 'done', chunks: 120, vectors: 120, elapsed_ms: 2400 },
    ),
  },
  get_batch_progress: {
    ...ingestStory.get_batch_progress,
    state: 'done', stage: 'searchable', done: 10, total: 10, chunks: 1412, vectors: 1412, throughput_cps: 48.3, eta_s: null, elapsed_s: 292, current_files: [],
    stages: ingestStory.get_batch_progress.stages.map((stage) => ({ ...stage, done: 10, percent: 100 })),
  },
}
