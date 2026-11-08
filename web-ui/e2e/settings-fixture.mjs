// 系统设置页的带状态假后端:在通用 fixture 之上再叠一层,让场景里「改一个值 → 保存 → 重读看到新值」。
//
// 用法(场景里):
//   import { settingsFixture, settingsLog } from './settings-fixture.mjs'
//   fixture: settingsFixture({ updateFail: { times: 1, status: 400, message: '…' } })
// 每个浏览器上下文调用一次 __after,各自一份状态,设备 × 引擎之间不串。写操作记进 log,
// 场景用 `settingsLog(tab)` 读出来断言「发出去的请求对不对」。
//
// 形状对照后端:kb-service/src/web.rs(update_config 的合并语义)、kb-core/src/config.rs(classify_change)、
// kb-cli/src/capability_backend.rs(provider_* / acp_* / llm_providers / set_llm_key)。
import { NOW } from './fixture.mjs'

/** 与 config.rs 的默认值一致(再带一点贴近真实部署的取值),只含设置页会读的段。 */
export const SETTINGS_CONFIG = {
  server: { listen: '127.0.0.1:7878', allow_remote: false, socket: '' },
  paths: { models_dir: '' },
  network: { hf_cdn_direct: true, crawl_allow_private: false },
  embed: { backend: 'fastembed', model: 'bge-m3-int8', max_tokens: 512, batch_size: 8, threads: 0, preload: true, idle_unload_minutes: 0, compat_group: 'bge-m3', http: { url: 'http://127.0.0.1:18081/v1/embeddings', model: 'bge-m3', dim: 1024 } },
  rerank: { mode: 'auto', url: 'http://127.0.0.1:18082/v1/rerank', top_n: 20, truncate_chars: 400, budget_ms: 3000 },
  accel: { enabled: false },
  index: { max_file_bytes: 204800, watch: true, debounce_ms: 2000, parallel_slices: 0, exclude: ['**/node_modules/**', '**/target/**'] },
  search: { k: 8, global_weight: 0.8, rrf_k: 60, window_context_lines: 8, mcp_max_output_chars: 24000, collection_weights: { proj_sampleapp: 1.1 } },
  mcp: { transports: ['stdio', 'http'], allowed_hosts: [] },
  llm: { provider: 'deepseek', base_url: 'https://api.deepseek.com', extract_model: 'deepseek-flash', review_model: 'deepseek-v4-pro', agent_model: 'deepseek-v4-pro', daily_token_budget: 2_000_000, max_calls_per_hour: 60 },
  evolution: { extract_enabled_default: false, review_mode: 'ai', approve_threshold: 0.7, dedup_similarity: 0.92, session_roots: ['~/.claude', '~/.kiro'] },
  schedule: { nightly_at: '03:00', optimize_interval_minutes: 60 },
  backup: { enabled: true, interval_hours: 24, keep_count: 7, keep_days: 0, include_sources: false, mirror_dirs: ['/mnt/usb/kb-backups', '/mnt/nas/kb-offsite'] },
  meta: { read_pool: 4 },
  upload: { max_file_mb: 512 },
  extract: { ocr_enabled: true, ocr_backend: 'rapidocr', ocr_model_size: 'small', ocr_language: 'chi_sim+eng', transcribe_enabled: false, transcribe_command: 'whisper-cli', max_media_seconds: 1800 },
  skills: { allow_exec: false },
  log: { level: 'info' },
  ai: { enabled: true, extract: true, deep_search: true, organize: true, assistant: true, acp: true, chunk_context: false },
}

// ---- 与 config.rs 的 classify_change 同一套规则(场景里不引用 TS 源码)
const HOT_PREFIXES = ['search.', 'ai.', 'accounts.', 'quota.', 'share.', 'site.', 'mail.', 'rerank.', 'schedule.', 'backup.']
const HOT_KEYS = ['log.level', 'index.exclude', 'index.parallel_slices', 'evolution.session_roots', 'llm.daily_token_budget', 'llm.max_calls_per_hour', 'llm.provider', 'llm.base_url', 'llm.extract_model', 'llm.review_model', 'llm.agent_model']
const scopeOf = (key) => (key.startsWith('embed.') ? 'migration' : HOT_PREFIXES.some((p) => key.startsWith(p)) || HOT_KEYS.includes(key) ? 'hot' : 'restart')

const leaves = (value, prefix = '') =>
  value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value).flatMap(([key, item]) => leaves(item, prefix ? `${prefix}.${key}` : key)) : [[prefix, value]]

const provider = (extra) => ({ name: extra.id, installed: false, ready: false, current: false, detail: null, model: null, install_command: null, removable: false, ...extra })
const PROVIDERS = [
  provider({ kind: 'ocr', id: 'rapidocr', installed: true, ready: true, current: true, detail: '就绪 · PP-OCRv6 small', install_command: 'rapidocr --install --model-dir models/ocr/ppocrv6', removable: true }),
  provider({ kind: 'ocr', id: 'tesseract', detail: '找不到命令 tesseract;装上 tesseract 即可作为降级后端', install_command: 'apt-get install tesseract-ocr' }),
  provider({ kind: 'transcribe', id: 'whisper-cli', current: true, detail: '找不到命令 whisper-cli;装上 whisper.cpp 或指向薄封装脚本', install_command: 'bash install-whisper.sh' }),
  provider({ kind: 'embed', id: 'bge-m3-int8', installed: true, ready: true, current: true, detail: '就绪' }),
  provider({ kind: 'rerank', id: 'http-rerank', installed: true, ready: true, current: true, detail: '就绪' }),
]
const ENV = { cpu_cores: 16, memory_mb: 64036, disk_free_gb: 412, has_nvidia: false, gpu: 'Intel 核显(/dev/dri)', has_intel_gpu: true, tools: ['ffmpeg', 'git'] }
const RECOMMENDATIONS = [
  { kind: 'ocr', provider: 'rapidocr', reason: '没有独显,CPU 推理:RapidOCR small 精度接近同代 Paddle,内存占用低', already_current: true },
  { kind: 'transcribe', provider: 'whisper-cli', reason: '未检测到 whisper.cpp;转写保持关闭(不影响入库)', already_current: false },
]

const agent = (extra) => ({ name: extra.id, command: extra.id, args: [], env: {}, npm: '', docs: '', env_hint: null, builtin: true, available: false, ...extra })
const AGENTS = [
  agent({ id: 'claude', name: 'Claude Code', command: 'claude-code-acp', npm: '@zed-industries/claude-code-acp@latest', available: true, env: { ANTHROPIC_API_KEY: '••••' }, env_hint: { base: 'ANTHROPIC_BASE_URL', key: 'ANTHROPIC_API_KEY', model: 'ANTHROPIC_MODEL' } }),
  agent({ id: 'codex', name: 'Codex', command: 'codex-acp', npm: '@openai/codex-acp@latest' }),
  agent({ id: 'gemini', name: 'Gemini CLI', command: 'gemini', args: ['--experimental-acp'], docs: 'https://github.com/google-gemini/gemini-cli' }),
  agent({ id: 'mine', name: '我的代理', command: '/opt/my-agent/bin/agent-with-a-rather-long-name', args: ['--acp', '--verbose'], builtin: false, available: true }),
]

const LLM_CATALOG = [
  { id: 'deepseek', name: 'DeepSeek', env_var: 'DEEPSEEK_API_KEY', base_url: 'https://api.deepseek.com', configured: true, current: true, model: 'deepseek-flash', note: null, supported: true },
  { id: 'openai', name: 'OpenAI', env_var: 'OPENAI_API_KEY', base_url: 'https://api.openai.com/v1', configured: false, current: false, model: null, note: null, supported: true },
  { id: 'anthropic', name: 'Anthropic', env_var: 'ANTHROPIC_API_KEY', base_url: 'https://api.anthropic.com', configured: false, current: false, model: null, note: 'Anthropic 不是 OpenAI 兼容接口,本版本不支持直连', supported: false },
  { id: 'ollama', name: '本地 Ollama', env_var: null, base_url: 'http://127.0.0.1:11434', configured: false, current: false, model: null, note: '本机模型,不需要密钥', supported: true },
]

const SKILLS = {
  dir: '/home/user/.kb/skills',
  allow_exec: false,
  warnings: ['skills/broken/manifest.toml:3 缺少 type 字段,已跳过'],
  skills: [
    { id: 'proto', name: 'proto', manifest: '/home/user/.kb/skills/proto/manifest.toml', kind: 'loader-rule', enabled: true, rules: ['**/*.proto → text · proto'], prompt_stages: [], template_required: [] },
    { id: 'review-prompt', name: 'review-prompt', manifest: '/home/user/.kb/skills/review-prompt/manifest.toml', kind: 'prompt', enabled: true, rules: [], prompt_stages: ['review'], template_required: [] },
    { id: 'insight-template', name: 'insight-template', manifest: '/home/user/.kb/skills/insight-template/manifest.toml', kind: 'insight-template', enabled: false, rules: [], prompt_stages: [], template_required: ['title', 'body', 'tags'] },
  ],
}


const HOUR = 3_600_000
const BACKUP_ENTRIES = [
  { name: 'kb-20261019-004200.tar.gz', size_bytes: 14_680_064, created_at: NOW - 26 * HOUR },
  { name: 'kb-20261018-004200.tar.gz', size_bytes: 14_417_920, created_at: NOW - 50 * HOUR },
  { name: 'kb-20261017-213015.tar.gz', size_bytes: 4_194_304, created_at: NOW - 74 * HOUR },
]
const MIRRORS = [
  { dir: '/mnt/usb/kb-backups', last_ok_at: NOW - 26 * HOUR, last_error: null, error_at: 0, copies: 3, has_latest: true },
  { dir: '/mnt/nas/kb-offsite', last_ok_at: NOW - 50 * HOUR, last_error: '建目录 /mnt/nas/kb-offsite 失败: No such file or directory', error_at: NOW - 26 * HOUR, copies: 1, has_latest: false },
]
const USAGE = { meta_db_bytes: 12_582_912, lance_bytes: 1_073_741_824, sources_bytes: 268_435_456, uploads_bytes: 0, skills_bytes: 4096, eval_bytes: 131_072, config_bytes: 3072, backups_bytes: 33_292_288 }
const BACKUP_NOTES = [
  '备份内容:元数据库、config.toml、skills、评测数据;原件(sources)可选',
  '不备份:向量表与模型(重建索引可恢复)、secrets.toml(含 API key)',
  '恢复方式:停守护进程 → 把归档解到 KB_HOME → 启动 → 按需重建索引',
]

const meta = { took_ms: 1, dry_run: false, batch_id: null, degraded: null, warnings: [] }

/**
 * 场景用的 overrides。options:
 *   config           覆盖 SETTINGS_CONFIG 的某些段(浅合并到段)
 *   updateFail       { times, status, message, code }:update_config 前 N 次失败
 *   configFail       { times, status, message }:get_config 前 N 次失败(报错重试 / 无权限)
 *   secret           一开始有没有保存密钥(默认有)
 *   testFail         { message, status }:test_llm 失败
 *   catalogFail      { status, message }:llm_providers 失败
 *   providersFail    { status, message }:provider_list 失败
 *   acpFail          { status, message }:acp_agents 失败
 *   noAgents         acp 代理列表为空
 *   configDelay      每次 get_config 都慢多少毫秒(看加载骨架屏)
 *   tuneRollback     应用调权后评测得分下降,被回滚
 *   skills           覆盖 list_skills 的返回(例如空清单)
 *   statusFail       { status, message }:backup_status 失败
 *   backupFail       { message }:backup_create 失败
 *   verifyFail       { message }:backup_verify 失败
 *   noBackups        一份备份都没有
 *   alert            { kind, error }:有一条未解决的备份失败告警
 *   me               覆盖 /auth/me(例如关闭 AI)
 */
export function settingsFixture(options = {}) {
  const base = {
    list_skills: options.skills ?? SKILLS,
    ...(options.me ? { __me: options.me } : {}),
  }
  return { ...base, __after: (context) => installSettingsApi(context, options) }
}

export async function installSettingsApi(context, options = {}) {
  const state = {
    config: structuredClone(SETTINGS_CONFIG),
    secret: options.secret ?? true,
    permission: 'read',
    sandbox: true,
    defaultAgent: '',
    agents: options.noAgents ? [] : structuredClone(AGENTS),
    providers: structuredClone(PROVIDERS),
    install: { state: 'idle', lines: 0, tail: [], error: null, command: '' },
    installPolls: 0,
    backups: options.noBackups ? [] : structuredClone(BACKUP_ENTRIES),
    backupSeq: 0,
    configCalls: 0,
    updateCalls: 0,
    log: [],
  }
  for (const [section, keys] of Object.entries(options.config ?? {})) state.config[section] = { ...state.config[section], ...keys }

  const reply = (route, data, status = 200) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(status < 300 ? { ok: true, data, meta } : { ok: false, error: data }),
    })
  const fail = (status, message, code) => {
    throw { status, message, code }
  }

  const handlers = {
    get_config: async () => {
      state.configCalls += 1
      if (options.configDelay) await new Promise((resolve) => setTimeout(resolve, options.configDelay))
      const failure = options.configFail
      if (failure && (failure.times === undefined || state.configCalls <= failure.times)) fail(failure.status ?? 500, failure.message ?? '配置文件读不了', failure.code ?? (failure.status === 403 ? 'forbidden' : 'internal'))
      return structuredClone(state.config)
    },
    update_config: ({ patch }) => {
      state.updateCalls += 1
      state.log.push({ name: 'update_config', patch })
      const failure = options.updateFail
      if (failure && (failure.times === undefined || state.updateCalls <= failure.times)) fail(failure.status ?? 500, failure.message ?? '写入配置失败', failure.code ?? 'internal')
      const changedKeys = []
      for (const [key, value] of leaves(patch)) {
        const [section, ...rest] = key.split('.')
        const name = rest.join('.')
        const before = JSON.stringify(state.config[section]?.[name])
        if (before !== JSON.stringify(value)) changedKeys.push(key)
        state.config[section] = { ...state.config[section], [name]: value }
      }
      const restart = changedKeys.filter((key) => scopeOf(key) === 'restart')
      return {
        applied: true,
        restart_required: restart.length > 0,
        restart_keys: restart,
        hot: changedKeys.filter((key) => scopeOf(key) === 'hot'),
        changed: [...new Set(changedKeys.map((key) => key.split('.')[0]))],
        migration_plan: null,
        notes: [],
      }
    },
    llm_providers: () => {
      if (options.catalogFail) fail(options.catalogFail.status ?? 500, options.catalogFail.message ?? '目录读不了')
      return { providers: LLM_CATALOG.map((item) => ({ ...item, current: item.id === state.config.llm.provider })), current: state.config.llm.provider, secret_present: state.secret }
    },
    set_llm_key: ({ api_key }) => {
      state.log.push({ name: 'set_llm_key', cleared: !String(api_key).trim() })
      state.secret = !!String(api_key).trim()
      return { secret_present: state.secret, provider: state.config.llm.provider }
    },
    test_llm: () => {
      state.log.push({ name: 'test_llm' })
      if (options.testFail) fail(options.testFail.status ?? 400, options.testFail.message ?? '当前服务商没有 API key:先保存密钥,或设置对应的环境变量')
      return { provider: state.config.llm.provider, reply: '你好!我是 DeepSeek。' }
    },
    provider_list: () => {
      if (options.providersFail) fail(options.providersFail.status ?? 500, options.providersFail.message ?? '组件目录读不了')
      return { providers: structuredClone(state.providers), env: ENV }
    },
    recommend_providers: () => ({ recommendations: RECOMMENDATIONS }),
    ocr_status: () => {
      if (state.install.state === 'running' && ++state.installPolls >= 2) {
        state.install = { state: 'done', lines: 14, tail: ['Downloading model', 'Verifying checksum', 'Done'], error: null, command: state.install.command }
        const tesseract = state.providers.find((item) => item.id === 'tesseract')
        if (tesseract) Object.assign(tesseract, { installed: true, ready: true, detail: '就绪' })
      }
      return { enabled: state.config.extract.ocr_enabled, backend: state.config.extract.ocr_backend, model_size: state.config.extract.ocr_model_size, model_dir: null, install_command: 'rapidocr --install', install: structuredClone(state.install) }
    },
    provider_install: ({ kind, id }) => {
      state.log.push({ name: 'provider_install', kind, id })
      state.install = { state: 'running', lines: 3, tail: ['Resolving mirror', 'Downloading model'], error: null, command: state.providers.find((item) => item.id === id)?.install_command ?? '' }
      state.installPolls = 0
      return { started: true, command: state.install.command }
    },
    provider_set_default: ({ kind, id }) => {
      state.log.push({ name: 'provider_set_default', kind, id })
      state.providers.forEach((item) => {
        if (item.kind === kind) item.current = item.id === id
      })
      state.config.extract.ocr_backend = id
      return { applied: true, changed: ['extract'] }
    },
    provider_uninstall: ({ kind, id }) => {
      state.log.push({ name: 'provider_uninstall', kind, id })
      return { removed: 3, dir: '/home/user/.kb/models/ocr/ppocrv6' }
    },

    backup_status: () => {
      if (options.statusFail) fail(options.statusFail.status ?? 500, options.statusFail.message ?? '归档目录读不了', options.statusFail.status === 403 ? 'forbidden' : 'internal')
      const policy = state.config.backup
      const failure = options.alert ? { at: NOW - HOUR, trigger: 'auto', kind: options.alert.kind ?? 'mirror', error: options.alert.error ?? '外接盘没挂上' } : null
      return {
        home: '/home/user/.kb',
        dir: '/home/user/.kb/backups',
        entries: structuredClone(state.backups),
        last_backup_at: state.backups[0]?.created_at ?? null,
        policy: structuredClone(policy),
        next_backup_at: policy.enabled ? NOW + 22 * HOUR : null,
        last_auto: state.backups.length ? { at: NOW - 26 * HOUR, ok: true, error: null } : null,
        progress: null,
        alert: failure,
        failures: failure ? [failure, { at: NOW - 30 * HOUR, trigger: 'manual', kind: 'pack', error: '磁盘已满' }] : [],
        mirrors: policy.mirror_dirs.length ? MIRRORS.filter((item) => policy.mirror_dirs.includes(item.dir)) : [],
        last_check: state.backups.length ? { at: NOW - 26 * HOUR, name: state.backups[0].name, ok: true, error: null, files: 12, uncompressed_bytes: 15_728_640, meta_db_bytes: 12_582_912 } : null,
        usage: USAGE,
        notes: BACKUP_NOTES,
      }
    },
    backup_state: () => ({ running: null, alert: null, failures: [], last_success_at: NOW - 26 * HOUR }),
    backup_create: ({ include_sources }) => {
      state.log.push({ name: 'backup_create', include_sources })
      if (options.backupFail) fail(500, options.backupFail.message ?? '磁盘空间不够')
      state.backupSeq += 1
      const entry = { name: `kb-2026102${state.backupSeq}-100000.tar.gz`, size_bytes: include_sources ? 281_018_368 : 15_728_640, created_at: NOW, skipped: 0 }
      state.backups.unshift({ name: entry.name, size_bytes: entry.size_bytes, created_at: entry.created_at })
      return entry
    },
    backup_delete: ({ name }) => {
      state.log.push({ name: 'backup_delete', archive: name })
      state.backups = state.backups.filter((item) => item.name !== name)
      return { deleted: name }
    },
    backup_prune: () => {
      state.log.push({ name: 'backup_prune' })
      const removed = state.backups.splice(state.config.backup.keep_count || state.backups.length).map((item) => item.name)
      return { removed, kept: state.backups.length, failed: [], dry_run: false }
    },
    backup_verify: ({ name }) => {
      state.log.push({ name: 'backup_verify', archive: name })
      if (options.verifyFail) fail(400, options.verifyFail.message ?? 'manifest.json 缺失')
      return { name, size_bytes: 14_680_064, created_at: NOW, version: '0.4.0', include_sources: false, files: 12, uncompressed_bytes: 15_728_640, meta_db_bytes: 12_582_912, config_present: true, skipped: [], roots: [] }
    },

    tune_retrieval: ({ dry_run }) => {
      state.log.push({ name: 'tune_retrieval', dry_run })
      const plan = {
        feedback: 128,
        matched: 121,
        overall_rate: 0.71,
        groups: [
          { collection: 'proj_sampleapp', kind: 'doc', prefix: 'docs', total: 42, useful: 37, rate: 0.881 },
          { collection: 'proj_sampleapp', kind: 'code', prefix: 'backend', total: 26, useful: 15, rate: 0.577 },
        ],
        suggestions: [
          { collection: 'proj_sampleapp', current: 1, suggested: 1.2, delta: 0.2, samples: 42, useful_rate: 0.881, reason: '有用率 88% 比全局高 17 个百分点,权重上调 0.20' },
          { collection: 'proj_sampleproj', current: 1, suggested: 0.95, delta: -0.05, samples: 18, useful_rate: 0.667, reason: '有用率接近全局均值,权重小幅下调 0.05' },
        ],
        skipped: ['proj_demo 只有 3 条反馈,样本不足(需要 ≥ 5)'],
      }
      if (dry_run) return plan
      return options.tuneRollback
        ? { ...plan, applied: false, rolled_back: true, eval: { before: { mrr: 0.93 }, after: { mrr: 0.9 } } }
        : { ...plan, applied: true, eval: { before: { mrr: 0.9 }, after: { mrr: 0.92 } } }
    },
    acp_agents: () => {
      if (options.acpFail) fail(options.acpFail.status ?? 500, options.acpFail.message ?? 'acp.toml 读不了', options.acpFail.status === 403 ? 'forbidden' : 'internal')
      return { permission: state.permission, default: state.defaultAgent, sandbox: state.sandbox, tool_groups: ['knowledge'], workspace_mb: 0, agents: structuredClone(state.agents) }
    },
    acp_set_permission: ({ permission }) => ((state.log.push({ name: 'acp_set_permission', permission }), (state.permission = permission)), { permission }),
    acp_set_sandbox: ({ sandbox }) => ((state.log.push({ name: 'acp_set_sandbox', sandbox }), (state.sandbox = sandbox)), { sandbox }),
    acp_set_default: ({ id }) => ((state.log.push({ name: 'acp_set_default', id }), (state.defaultAgent = id)), { default: id }),
    acp_test: ({ id }) => ({ name: state.agents.find((item) => item.id === id)?.name ?? id, version: '1.4.2' }),
    acp_install: ({ id }) => {
      state.log.push({ name: 'acp_install', id })
      const found = state.agents.find((item) => item.id === id)
      if (found) found.available = true
      return { ok: true }
    },
    acp_uninstall: ({ id }) => {
      state.log.push({ name: 'acp_uninstall', id })
      const found = state.agents.find((item) => item.id === id)
      if (found) found.available = false
      return { ok: true }
    },
    acp_remove_agent: ({ id }) => ((state.log.push({ name: 'acp_remove_agent', id }), (state.agents = state.agents.filter((item) => item.id !== id))), { removed: id }),
    acp_save_agent: (args) => {
      state.log.push({ name: 'acp_save_agent', id: args.id, env: args.env, command: args.command, args: args.args })
      const existing = state.agents.find((item) => item.id === args.id)
      if (existing) Object.assign(existing, { name: args.name, env: Object.fromEntries(Object.entries(args.env ?? {}).map(([key, value]) => [key, value ? '••••' : ''])) })
      else state.agents.push(agent({ id: args.id, name: args.name, command: args.command, args: args.args, builtin: false, available: true }))
      return { saved: args.id }
    },
  }

  await context.route('**/api/v1/capabilities/*', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop()
    const handler = handlers[name]
    if (!handler) return route.fallback()
    try {
      return reply(route, await handler(route.request().postDataJSON() ?? {}))
    } catch (error) {
      if (error && typeof error === 'object' && 'status' in error) return reply(route, { code: error.code ?? (error.status === 403 ? 'forbidden' : error.status === 400 ? 'invalid_input' : 'internal'), message: error.message }, error.status)
      throw error
    }
  })
  // 测试钩子:读出发过的写操作和当前配置
  await context.route('**/api/v1/__fixture/settings', (route) => reply(route, { log: state.log, config: state.config, secret: state.secret, permission: state.permission, sandbox: state.sandbox }))
}

/** 场景里读出假后端收到的写操作。 */
export const settingsLog = (tab) => tab.evaluate(() => fetch('/api/v1/__fixture/settings').then((response) => response.json())).then((body) => body.data)

export { NOW }
