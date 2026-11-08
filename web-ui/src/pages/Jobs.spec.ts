// 任务页:服务端分页与筛选、job_stats 的指标和图表、任务详情(摘要)、加载 / 报错 / 空状态、手机任务卡与详情弹层、
// 取消、刷新失败、AI 总开关、刷新节奏(事件合并、隐藏不轮询)。
// 假后端按请求参数真的去筛选、排序、分页、统计,所以断言的是「页面发了什么参数、拿到结果后显示了什么」。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { reactive } from 'vue'
import { KbPager, KbSelect, PHONE_QUERY } from '@kb-ui/index'
import { useSessionStore } from '@/stores/session'
import type { JobFileRow } from '@/api/jobs'
import type { LiveEvent } from '@/composables/useLiveEvents'

const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  callCapability: (...args: unknown[]) => callCapability(...args),
}))
const push = vi.fn()
const replace = vi.fn()
const route = reactive<{ path: string; query: Record<string, string> }>({ path: '/tasks', query: {} })
vi.mock('vue-router', () => ({ useRoute: () => route, useRouter: () => ({ push, replace }), RouterLink: { props: ['to'], template: '<a><slot /></a>' } }))
vi.mock('@/layouts/AppShell.vue', () => ({ default: { template: '<div class="app-shell"><slot /></div>' } }))
const listeners = new Set<(event: LiveEvent) => void>()
vi.mock('@/composables/useLiveEvents', () => ({
  useLiveEvents: (listener: (event: LiveEvent) => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  subscribeLive: (listener: (event: LiveEvent) => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}))
const emit = (type: string, data: Record<string, unknown> = {}) => [...listeners].forEach((listener) => listener({ type, data }))

import { CapabilityError } from '@/api/client'
import Jobs from './Jobs.vue'

const T0 = Date.UTC(2026, 9, 21, 0, 0, 0)
type FakeJob = Record<string, unknown> & { id: string; kind: string; state: string; created_at: number; started_at: number | null; finished_at: number | null }
const job = (id: string, kind: string, state: string, extra: Record<string, unknown> = {}): FakeJob => ({
  id,
  kind,
  collection: 'SampleApp/docs',
  state,
  progress_done: state === 'done' ? 100 : 40,
  progress_total: 100,
  rate: null,
  error: null,
  detail: 'bge-m3 · 912 块',
  created_at: T0 - 60_000,
  started_at: state === 'queued' ? null : T0 - 30_000,
  finished_at: state === 'done' || state === 'failed' ? T0 : null,
  ...extra,
})
const JOBS = [job('j1', 'reindex', 'running'), job('j2', 'evolve', 'queued'), job('j3', 'ingest', 'done'), job('j4', 'embed', 'failed', { error: 'sidecar timeout', finished_at: T0 - 1 })]
const BATCHES = [{ id: 'bat_1', actor: 'mcp · Kiro', description: 'kb_add_insight ×3', protocol: '2025-03-26', created_at: T0, reverted_at: null, changes: [{ seq: 1, target: 't', op: 'insight.create', revertible: true }] }]

/* ------------------------------------------------------------ 假后端:和 kb-meta 的 list_page / stats 同一套规则 */
const rank = (state: string) => (state === 'running' ? 0 : state === 'queued' ? 1 : 2)
function serveList(all: FakeJob[], args: Record<string, unknown>) {
  const states = (args.states as string[] | undefined) ?? []
  const kinds = (args.kinds as string[] | undefined) ?? []
  const exclude = (args.exclude_kinds as string[] | undefined) ?? []
  const picked = all
    .filter((item) => (!states.length || states.includes(item.state)) && (!kinds.length || kinds.includes(item.kind)) && !exclude.includes(item.kind))
    .sort(
      (left, right) =>
        rank(left.state) - rank(right.state) ||
        (rank(left.state) < 2 ? left.created_at - right.created_at : (right.finished_at ?? right.created_at) - (left.finished_at ?? left.created_at)) ||
        left.id.localeCompare(right.id),
    )
  const page = (args.page as number | undefined) ?? 1
  const size = (args.page_size as number | undefined) ?? 50
  return { jobs: picked.slice((page - 1) * size, page * size), total: picked.length, page, page_size: size }
}
function serveStats(all: FakeJob[], args: Record<string, unknown>) {
  const exclude = (args.exclude_kinds as string[] | undefined) ?? []
  const picked = all.filter((item) => !exclude.includes(item.kind))
  const by_state: Record<string, number> = { queued: 0, running: 0, paused: 0, done: 0, failed: 0, canceled: 0 }
  const kinds = new Map<string, number>()
  for (const item of picked) {
    by_state[item.state] = (by_state[item.state] ?? 0) + 1
    kinds.set(item.kind, (kinds.get(item.kind) ?? 0) + 1)
  }
  const spans = picked.filter((item) => item.state === 'done' && item.started_at && item.finished_at).map((item) => item.finished_at! - item.started_at!).sort((a, b) => a - b)
  const buckets = [0, 0, 0, 0, 0]
  for (const span of spans) {
    const at = [10_000, 60_000, 300_000, 1_800_000].findIndex((edge) => span <= edge)
    buckets[at === -1 ? 4 : at]!++
  }
  const mid = Math.floor(spans.length / 2)
  const median = spans.length ? (spans.length % 2 ? spans[mid]! : (spans[mid - 1]! + spans[mid]!) / 2) : null
  const p95 = spans.length ? spans[Math.max(1, Math.ceil(spans.length * 0.95)) - 1]! : null
  const running = picked.find((item) => item.state === 'running')
  const queued = picked.filter((item) => item.state === 'queued').map((item) => item.created_at)
  return {
    total: picked.length,
    by_state,
    kinds: [...kinds.entries()].map(([kind, count]) => ({ kind, count })),
    recent: { hours: 24, since: 0, done: by_state.done, failed: by_state.failed, canceled: by_state.canceled, avg_ms: median },
    queue: { oldest_queued_at: queued.length ? Math.min(...queued) : null, first_running: running ? { kind: running.kind, collection: running.collection } : null },
    durations: { edges_ms: [10_000, 60_000, 300_000, 1_800_000], buckets, count: spans.length, median_ms: median, p95_ms: p95 },
    // 文本优先阶段留下的队列:任务页要多显示一张「待补向量」卡
    pending: {
      chunks: 7,
      files: 2,
      oldest_enqueued_at: 1,
      oldest_age_secs: 30,
      rate_per_sec: 0.5,
      eta_secs: 14,
      collections: [{ collection: 'proj_demo', chunks: 7, files: 2, oldest_enqueued_at: 1 }],
    },
  }
}
function serveBrief(all: FakeJob[], args: Record<string, unknown>) {
  const found = all.find((item) => item.id === args.id)
  if (!found) throw new CapabilityError('not found: job', 'not_found', 404)
  const failed = found.state === 'failed'
  return {
    job: {
      ...found,
      payload: { project_id: 'p1', mode: 'incremental', paths: { total: 1234, items: ['src/a.rs'] } },
      checkpoint: { done: 40, total: 100, embedded: 320, errors: failed ? 2 : 0, error_samples: failed ? ['src/a.rs: 读不出来'] : [] },
    },
  }
}

/** 逐文件记录(假后端):页面用 job_files 分页取,不经过摘要 */
const DEFAULT_FILES: Record<string, JobFileRow[]> = {
  j1: [
    { path: 'src/a.rs', change: 'update', chunks: 12, meta_chunks: 0, deleted_chunks: 0, error: null, done_at: T0 },
    { path: 'src/b.rs', change: 'new', chunks: 5, meta_chunks: 0, deleted_chunks: 0, error: null, done_at: T0 },
    { path: 'src/c.rs', change: 'error', chunks: 0, meta_chunks: 0, deleted_chunks: 0, error: 'permission denied: src/c.rs', done_at: T0 },
    { path: 'src/d.rs', change: 'skip', chunks: 0, meta_chunks: 0, deleted_chunks: 0, error: null, done_at: T0 },
  ],
}
let filesByJob: Record<string, JobFileRow[]> = {}
function serveFiles(all: FakeJob[], args: Record<string, unknown>) {
  const found = all.find((item) => item.id === args.id)
  if (!found) throw new CapabilityError('not found: job', 'not_found', 404)
  const all_rows = filesByJob[found.id] ?? []
  const page = (args.page as number | undefined) ?? 1
  const size = (args.page_size as number | undefined) ?? 200
  const counts: Record<string, number> = {}
  for (const row of all_rows) counts[row.change] = (counts[row.change] ?? 0) + 1
  return { job_id: found.id, total: all_rows.length, page, page_size: size, counts, items: all_rows.slice((page - 1) * size, page * size) }
}

let jobs: FakeJob[] = JOBS
let replies: Record<string, unknown> = {}
function backend(overrides: Record<string, unknown> = {}, list: FakeJob[] = JOBS) {
  jobs = list
  replies = {
    batch_list: { batches: BATCHES, total: 1 },
    audit_list: { entries: [], total: 0 },
    list_projects: { projects: [{ project: { name: 'knowledgeBase' } }] },
    // 取消 / 投递任务后页面会让外壳刷新计数(shell.refresh),它需要这几个接口有正常形状的回答
    stats_overview: { totals: { rows: 0 }, jobs: { queued: 0, running: 0 }, drafts_pending: 0, collections: [] },
    list_sources: { sources: [] },
    job_cancel: { job_id: 'j1', state: 'canceled' },
    reindex_project: { job_id: 'j9' },
    ...overrides,
  }
  callCapability.mockImplementation(async (name: string, args: Record<string, unknown> = {}) => {
    const reply = replies[name]
    if (reply instanceof Error) throw reply
    if (reply !== undefined) return reply
    if (name === 'job_list') return serveList(jobs, args)
    if (name === 'job_stats') return serveStats(jobs, args)
    if (name === 'job_get') return serveBrief(jobs, args)
    if (name === 'job_files') return serveFiles(jobs, args)
    return {}
  })
}
const calls = (name: string) => callCapability.mock.calls.filter((call) => call[0] === name)
const lastArgs = (name: string) => calls(name).at(-1)?.[1] as Record<string, unknown>
const $ = <T extends Element = HTMLElement>(selector: string) => document.body.querySelector<T>(selector)
const $$ = (selector: string) => [...document.body.querySelectorAll<HTMLElement>(selector)]
const rows = () => $$('.kb-jobs-table [data-testid=rt-row]')
const select = (label: string) => wrapper!.findAllComponents(KbSelect).find((item) => item.props('ariaLabel') === label)!

function setViewport(phone: boolean) {
  window.matchMedia = ((query: string) => ({ matches: phone && query === PHONE_QUERY, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia
}
let visibility: DocumentVisibilityState = 'visible'
let wrapper: VueWrapper | null = null
async function open(options: { phone?: boolean } = {}) {
  setViewport(options.phone ?? false)
  wrapper = mount(Jobs, { attachTo: document.body })
  await flushPromises()
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  wrapper?.unmount()
  wrapper = null
  listeners.clear()
  document.body.innerHTML = ''
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  callCapability.mockReset()
  push.mockClear()
  replace.mockClear()
  route.path = '/tasks'
  route.query = {}
  setActivePinia(createPinia())
  filesByJob = { ...DEFAULT_FILES }
  backend()
})
afterEach(() => vi.useRealTimers())

describe('Jobs 任务页 · 取数', () => {
  it('只要一页:job_list 带分页参数,统计走 job_stats;不再为日志调 system_status', async () => {
    await open()
    expect(lastArgs('job_list')).toEqual({ page: 1, page_size: 50 })
    // 统计两次:一次给指标卡和图(不带范围),一次给下面的任务趋势(带范围 24h)
    expect(calls('job_stats').map((call) => call[1])).toEqual(expect.arrayContaining([{}, { range: '24h' }]))
    expect(calls('job_stats')).toHaveLength(2)
    expect(calls('system_status')).toHaveLength(0)
  })

  it('待补向量有独立指标卡:块数、文件数与 ETA;没有队列时写「没有待补内容」', async () => {
    await open()
    const card = () => $('[data-testid=jobs-pending]')!.textContent!.replace(/\s+/g, ' ')
    expect(card()).toContain('待补向量')
    expect(card()).toContain('7')
    expect(card()).toContain('2 个文件')
    expect(card()).toContain('预计 14s')
  })

  it('详情只取选中的那个,而且是摘要模式', async () => {
    await open()
    expect(calls('job_get').map((call) => call[1])).toEqual([{ id: 'j1', brief: true }])
  })
})

describe('Jobs 任务页 · 桌面', () => {
  it('表格列出任务;运行中的排最前;点一行选中它(详情卡标题跟着变)', async () => {
    await open()
    expect(rows()[0]!.textContent).toContain('重建索引')
    expect($('[data-testid=job-detail-card]')!.textContent).toContain('j1')
    rows()[2]!.click()
    await flushPromises()
    expect($('[data-testid=job-detail-card]')!.textContent).toContain(rows()[2]!.textContent!.match(/j\d/)![0])
  })

  it('详情卡:方式和文件数、进度、写入向量;失败的任务整段写出原因和出错的文件', async () => {
    await open()
    const card = () => $('[data-testid=job-detail-card]')!.textContent!.replace(/\s+/g, ' ')
    expect(card()).toContain('增量 · 1234 个文件')
    expect(card()).toContain('40 / 100')
    expect(card()).toContain('320 块')
    expect($('[data-testid=job-failure]')).toBeNull()
    rows().find((row) => row.textContent!.includes('j4'))!.click()
    await flushPromises()
    expect($('[data-testid=job-failure]')!.textContent).toContain('sidecar timeout')
    expect($('[data-testid=job-error-samples]')!.textContent).toContain('src/a.rs: 读不出来')
  })

  it('「查看服务日志」只给有运维权限的人', async () => {
    const session = useSessionStore()
    session.features = new Set(['docs.notes'])
    session.loaded = true
    await open()
    expect($('[data-testid=job-logs-link]')).toBeNull()
    wrapper!.unmount()
    document.body.innerHTML = ''
    session.features = new Set(['docs.notes', 'sys.ops'])
    await open()
    expect($('[data-testid=job-logs-link]')).not.toBeNull()
  })

  it('筛选和「+ 新任务」在单独一行,不在页签里', async () => {
    await open()
    const bar = $('[data-testid=jobs-bar]')!
    expect(bar.textContent).toContain('状态')
    expect(bar.textContent).toContain('+ 新任务')
    expect($('.kb-jobs [role=tablist]')?.textContent ?? '').not.toContain('新任务')
  })

  it('取消运行中的任务:发 job_cancel 并刷新', async () => {
    await open()
    const before = calls('job_list').length
    const cancel = [...$('[data-testid=job-detail-card]')!.querySelectorAll('button')].find((button) => button.textContent!.includes('取消'))!
    cancel.click()
    await flushPromises()
    expect(calls('job_cancel')[0]![1]).toEqual({ id: 'j1' })
    expect(calls('job_list').length).toBeGreaterThan(before)
  })

  it('选「增量索引」发 reindex_project', async () => {
    await open()
    wrapper!.findAllComponents(KbSelect).at(-1)!.vm.$emit('update:modelValue', 'incremental:knowledgeBase')
    await flushPromises()
    expect(calls('reindex_project')[0]![1]).toEqual({ project: 'knowledgeBase', mode: 'incremental' })
  })

  it('投递任务失败:用提示说出原因,页面照常', async () => {
    backend({ reindex_project: new CapabilityError('invalid input: 项目正在迁移', 'invalid_input', 400) })
    await open()
    wrapper!.findAllComponents(KbSelect).at(-1)!.vm.$emit('update:modelValue', 'full:knowledgeBase')
    await flushPromises()
    expect($('[data-testid=jobs-error]')).toBeNull()
    expect(rows().length).toBe(4)
  })
})

describe('Jobs 任务页 · 状态', () => {
  it('桌面表格里失败的任务「详情」列也先写失败原因', async () => {
    await open()
    const failed = rows().find((row) => row.textContent!.includes('建立索引'))!
    expect(failed.textContent).toContain('sidecar timeout')
    expect(failed.textContent).not.toContain('bge-m3')
  })

  it('第一次取回之前是骨架屏', async () => {
    callCapability.mockImplementation(() => new Promise(() => undefined))
    setViewport(false)
    wrapper = mount(Jobs, { attachTo: document.body })
    await flushPromises()
    expect($('[role=status][aria-busy=true]')).not.toBeNull()
  })

  it('一次都没取成功:整块报错并给「重新加载」,点了重新取', async () => {
    backend({ job_list: new CapabilityError('internal: boom', 'internal', 500) })
    await open()
    expect($('[data-testid=jobs-error]')!.textContent).toContain('没能读取任务')
    backend()
    $<HTMLButtonElement>('[data-testid=jobs-error] button')!.click()
    await flushPromises()
    expect($('[data-testid=jobs-error]')).toBeNull()
    expect(rows().length).toBe(4)
  })

  it('取成功过之后轮询失败:保留旧数据,只提示「显示的是之前的数据」', async () => {
    await open()
    backend({ job_list: new CapabilityError('internal: boom', 'internal', 500) })
    await vi.advanceTimersByTimeAsync(10_000)
    expect($('[data-testid=jobs-stale]')).not.toBeNull()
    expect($('[data-testid=jobs-error]')).toBeNull()
    expect(rows().length).toBe(4)
    // 下一次成功后提示消失
    backend()
    await vi.advanceTimersByTimeAsync(10_000)
    expect($('[data-testid=jobs-stale]')).toBeNull()
  })

  it('没有任务:给出「没有符合条件的任务」', async () => {
    backend({}, [])
    await open()
    expect(document.body.textContent).toContain('没有符合条件的任务')
  })
})

describe('Jobs 任务页 · 类型名与 AI 任务', () => {
  const AI_WORD = /(?<![A-Za-z])AI(?![A-Za-z])/
  const kindOptions = () => select('按类型筛选').props('options') as { value: string; label: string }[]
  const tableText = () => rows().map((row) => row.textContent!.replace(/\s+/g, ' ')).join('\n')

  it('类型显示中文名,不露 reindex / evolve / embed / ingest 这类键名(表格、筛选、统计卡都一样)', async () => {
    await open()
    const text = tableText()
    for (const word of ['重建索引', '自动提炼', '导入解析', '建立索引']) expect(text, word).toContain(word)
    for (const raw of ['reindex', 'evolve', 'embed', 'ingest']) expect(text, raw).not.toContain(raw)
    expect(kindOptions().map((option) => option.label)).toEqual(['全部类型', '导入解析', '建立索引', '自动提炼', '重建索引'])
    // 统计卡(运行中那张写着正在跑的任务类型)
    expect($$('.kb-jobs .metric').map((card) => card.textContent).join(' ')).toContain('重建索引 · SampleApp/docs')
    expect($$('.kb-jobs .metric').map((card) => card.textContent).join(' ')).not.toContain('reindex')
  })

  it('类型筛选按中文名合并:evolve 和 extract 都叫「自动提炼」,选它两种类型一起发给服务端', async () => {
    backend({}, [job('j1', 'evolve', 'done'), job('j2', 'extract', 'done'), job('j3', 'ingest', 'done')])
    await open()
    expect(kindOptions().filter((option) => option.label === '自动提炼')).toHaveLength(1)
    select('按类型筛选').vm.$emit('update:modelValue', '自动提炼')
    await flushPromises()
    expect(lastArgs('job_list')).toMatchObject({ kinds: ['evolve', 'extract'], page: 1 })
    expect(rows()).toHaveLength(2)
  })

  it('状态筛选发给服务端,图不受影响(筛选是在找任务,图要回答整体情况)', async () => {
    await open()
    select('按状态筛选').vm.$emit('update:modelValue', 'failed')
    await flushPromises()
    expect(lastArgs('job_list')).toMatchObject({ states: ['failed'] })
    expect(rows()).toHaveLength(1)
    expect($$('[data-testid=jobs-state-chart] .kb-donut-row')).toHaveLength(4)
  })

  it('AI 总开关关闭:列表和统计都排除自动提炼 / 审核类任务,筛选里也没有,页面没有 AI 字样', async () => {
    backend({}, [...JOBS, job('j5', 'extract', 'running'), job('j6', 'review', 'done')])
    useSessionStore().aiEnabled = false
    await open()
    expect(lastArgs('job_list')).toMatchObject({ exclude_kinds: ['evolve', 'extract', 'review'] })
    expect(lastArgs('job_stats')).toMatchObject({ exclude_kinds: ['evolve', 'extract', 'review'] })
    const text = tableText()
    expect(text).not.toContain('自动提炼')
    expect(text).not.toContain('自动审核')
    expect(rows()).toHaveLength(3)
    expect(kindOptions().map((option) => option.label)).not.toContain('自动提炼')
    expect($('.kb-jobs')!.textContent).not.toMatch(AI_WORD)
    // 页签上的任务数也只算看得见的
    expect($('.kb-jobs [role=tablist]')!.textContent).toContain('3')
  })

  it('AI 开着:不排除任何类型,自动提炼类任务照常显示', async () => {
    backend({}, [...JOBS, job('j5', 'extract', 'running')])
    await open()
    expect(lastArgs('job_list')).not.toHaveProperty('exclude_kinds')
    expect(rows()).toHaveLength(5)
  })
})

describe('Jobs 任务页 · 手机', () => {
  it('任务表变成任务卡:类型、状态、目标、进度、开始 / 耗时都在卡上,不再是表格', async () => {
    await open({ phone: true })
    expect(rows().length).toBe(0)
    const cards = $$('[data-testid=job-card]')
    expect(cards).toHaveLength(4)
    const first = cards[0]!.textContent!.replace(/\s+/g, ' ')
    for (const word of ['重建索引', '运行中', 'j1', 'SampleApp/docs', '%', '开始', '耗时']) expect(first, word).toContain(word)
    const failed = cards.find((card) => card.textContent!.includes('j4'))!
    expect(failed.textContent).toContain('失败')
    // 失败的任务先说原因,不能被「详情」盖住
    expect(failed.textContent).toContain('sidecar timeout')
    expect(failed.textContent).not.toContain('bge-m3')
    expect(cards[0]!.textContent).toContain('bge-m3')
  })

  it('「+ 新任务」手机上也在屏内(以前被挤出页签栏)', async () => {
    await open({ phone: true })
    expect($('[data-testid=jobs-bar]')!.textContent).toContain('+ 新任务')
  })

  it('点任务卡:详情在底部弹层里;桌面那张详情卡不渲染', async () => {
    await open({ phone: true })
    expect($('[data-testid=job-detail-card]')).toBeNull()
    $$('[data-testid=rt-card]')[1]!.click()
    await flushPromises()
    expect($('.kb-sheet')).not.toBeNull()
    expect($('.kb-sheet')!.textContent).toContain('自动提炼')
    expect($('[data-testid=job-detail-sheet]')!.textContent).toContain('1234 个文件')
    expect(calls('job_get').at(-1)![1]).toEqual({ id: 'j2', brief: true })
  })

  it('弹层里能取消排队 / 运行中的任务;已结束的任务没有取消', async () => {
    await open({ phone: true })
    $$('[data-testid=rt-card]')[0]!.click()
    await flushPromises()
    const names = () => [...$('.kb-sheet')!.querySelectorAll('button')].map((button) => button.textContent!.trim())
    expect(names().some((name) => name.includes('取消任务'))).toBe(true)
    ;[...$('.kb-sheet')!.querySelectorAll('button')].find((button) => button.textContent!.includes('取消任务'))!.click()
    await flushPromises()
    expect(calls('job_cancel')[0]![1]).toEqual({ id: 'j1' })
    document.body.innerHTML = ''
    wrapper!.unmount()
    await open({ phone: true })
    $$('[data-testid=rt-card]')[2]!.click()
    await flushPromises()
    expect(names().some((name) => name.includes('取消任务'))).toBe(false)
  })

  it('审计日志页签在手机上也是卡片', async () => {
    route.path = '/admin/audit'
    backend({ audit_list: { entries: [{ id: 1, at: T0, actor: 'admin', capability: 'search_knowledge', ok: true, dry_run: false, batch_id: null, args_json: '{"query":"x"}', error: null }], total: 1 } })
    await open({ phone: true })
    expect($$('[data-testid=rt-card]')).toHaveLength(1)
    expect($('[data-testid=rt-card]')!.textContent).toContain('搜索')
    expect($('[data-testid=rt-card]')!.textContent).not.toContain('search_knowledge')
    expect($('[data-testid=rt-card]')!.textContent).toContain('成功')
  })
})

describe('Jobs 任务页 · 图表', () => {
  it('任务状态环形图:图例每行是中文状态名和数量,中间有说明', async () => {
    await open()
    const card = $('[data-testid=jobs-state-chart]')!
    // 图例每行是 名字 / 数量 / 占比 三格,按格取(格与格之间没有空白文本节点)
    const legend = [...card.querySelectorAll('.kb-donut-row')].map((row) => [...row.querySelectorAll('.kb-donut-name, .kb-donut-num, .kb-donut-pct')].map((cell) => cell.textContent))
    expect(legend).toEqual([
      ['运行中', '1', '25%'],
      ['排队', '1', '25%'],
      ['完成', '1', '25%'],
      ['失败', '1', '25%'],
    ])
    expect(card.textContent).toContain('共 4 个')
    expect(card.textContent).not.toMatch(/running|queued|failed|canceled/)
  })

  it('完成任务用时分布:只算已完成的,显示中位数和 P95', async () => {
    await open()
    const card = $('[data-testid=jobs-duration-chart]')!
    // j3 完成,用时 30 秒 → 「10 秒–1 分钟」这一段
    expect(card.textContent).toContain('中位数 30s')
    expect(card.textContent).toContain('95% 在 30s 内跑完')
    const bars = [...card.querySelectorAll('.kb-hbars-row')].map((row) => row.textContent!.replace(/\s+/g, ' ').trim())
    expect(bars).toHaveLength(5)
    expect(bars[1]).toContain('10 秒–1 分钟')
    expect(bars[1]).toContain('1 个 · 100%')
    expect(bars[0]).toContain('0 个 · 0%')
  })

  it('还没有完成的任务:用时那张卡说明原因,不画五行空条', async () => {
    backend({}, [job('j1', 'reindex', 'running'), job('j2', 'evolve', 'queued')])
    await open()
    const card = $('[data-testid=jobs-duration-chart]')!
    expect(card.textContent).toContain('还没有完成的任务')
    expect(card.querySelector('.kb-hbars-row')).toBeNull()
    expect($('[data-testid=jobs-state-chart]')).not.toBeNull()
  })

  it('一个任务都没有:不出现图表区(原来的空状态不变)', async () => {
    backend({}, [])
    await open()
    expect($('[data-testid=jobs-charts]')).toBeNull()
  })

  it('手机上也在,且不引入第二份任务卡', async () => {
    await open({ phone: true })
    expect($('[data-testid=jobs-charts]')).not.toBeNull()
    expect($$('[data-testid=job-card]')).toHaveLength(4)
  })

  it('AI 总开关关闭后,图里没有 AI 任务(自动提炼 / 审核)', async () => {
    useSessionStore().aiEnabled = false
    backend({}, [job('j1', 'reindex', 'running'), job('j2', 'evolve', 'queued'), job('j3', 'ingest', 'done')])
    await open()
    expect($$('[data-testid=jobs-state-chart] .kb-donut-row')).toHaveLength(2)
    expect($('[data-testid=jobs-state-chart]')!.textContent).toContain('共 2 个')
  })
})

describe('Jobs 任务页 · 历史任务很多时按页取', () => {
  // 生产上历史任务累积到 1.4 万个:表格一次只取一页(50 个),指标和图表是服务端按全部任务算的
  const many = [
    job('run', 'reindex', 'running'),
    ...Array.from({ length: 250 }, (_, index) => job(`d${String(index).padStart(3, '0')}`, 'ingest', 'done', { finished_at: T0 - index * 1000 })),
    ...Array.from({ length: 30 }, (_, index) => job(`f${index}`, 'embed', 'failed', { error: '句柄耗尽', finished_at: T0 - index * 1000 - 500 })),
  ]

  it('表格只有一页 50 个,分页条写清一共多少;图表仍是全部', async () => {
    backend({}, many)
    await open()
    expect(rows()).toHaveLength(50)
    expect($('[data-testid=jobs-pager]')!.textContent).toContain('281 条中第 1–50 条')
    expect($('[data-testid=jobs-state-chart]')!.textContent).toContain('共 281 个')
  })

  it('翻页向服务端要第二页;换筛选条件回到第一页', async () => {
    backend({}, many)
    await open()
    wrapper!.findComponent(KbPager).vm.$emit('update:page', 2)
    await flushPromises()
    expect(lastArgs('job_list')).toMatchObject({ page: 2, page_size: 50 })
    expect($('[data-testid=jobs-pager]')!.textContent).toContain('第 51–100 条')
    select('按状态筛选').vm.$emit('update:modelValue', 'done')
    await flushPromises()
    expect(lastArgs('job_list')).toMatchObject({ page: 1, states: ['done'] })
    expect($('[data-testid=jobs-pager]')!.textContent).toContain('250 条中第 1–50 条')
  })

  it('任务不多时没有分页条', async () => {
    await open()
    expect($('[data-testid=jobs-pager]')).toBeNull()
    expect(rows()).toHaveLength(4)
  })
})

describe('Jobs 任务页 · 刷新节奏', () => {
  it('一连串任务完成的推送合并成一次刷新', async () => {
    await open()
    const before = calls('job_list').length
    for (let index = 0; index < 5; index++) {
      emit('job.done', { job_id: `x${index}` })
      await vi.advanceTimersByTimeAsync(200)
    }
    expect(calls('job_list').length).toBe(before)
    await vi.advanceTimersByTimeAsync(1_500)
    expect(calls('job_list').length).toBe(before + 1)
  })

  it('页上任务的进度推送只更新进度条,不重新取列表', async () => {
    await open()
    const before = calls('job_list').length
    emit('job.progress', { job_id: 'j1', done: 90, total: 100 })
    await vi.advanceTimersByTimeAsync(3_000)
    expect(calls('job_list').length).toBe(before)
    expect(rows()[0]!.textContent).toContain('90%')
  })

  it('页面隐藏时不轮询;回到前台立刻刷新一次', async () => {
    await open()
    const before = calls('job_list').length
    visibility = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(calls('job_list').length).toBe(before)
    visibility = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    await flushPromises()
    expect(calls('job_list').length).toBe(before + 1)
  })

  it('空闲(没有运行中和排队的任务)时 30 秒轮询一次,忙时 10 秒', async () => {
    backend({}, [job('j3', 'ingest', 'done')])
    await open()
    const before = calls('job_list').length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls('job_list').length).toBe(before)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(calls('job_list').length).toBe(before + 1)
  })
})

describe('Jobs 任务页 · 文件详情与跳转', () => {
  it('单文件详情展示为链接,包含具体文件名', async () => {
    backend({}, [job('j_single', 'index', 'done', { detail: 'crates/kb-cli/src/main.rs', collection: 'proj_kb' })])
    await open()
    const link = $('[data-testid=job-cell-link]')
    expect(link).not.toBeNull()
    expect(link!.textContent).toBe('crates/kb-cli/src/main.rs')
  })

  it('失败任务的原因是普通文字:原因里的「1/3」「.」不能被当成文件路径做成链接', async () => {
    backend({}, [
      job('j_err1', 'embed', 'failed', { error: 'sidecar timeout · 重试 1/3', collection: 'proj_kb' }),
      job('j_err2', 'ingest', 'failed', { error: '抽取失败: docs/big.pdf', collection: 'proj_kb' }),
      job('j_err3', 'evolve', 'failed', { error: '笔记 ins_8f21 写入失败', collection: 'proj_kb' }),
    ])
    await open()
    expect($('[data-testid=job-cell-link]')).toBeNull()
    expect($('[data-testid=job-cell-insight-link]')).toBeNull()
    expect($('[data-testid=job-cell-files-btn]')).toBeNull()
    expect(document.body.textContent).toContain('sidecar timeout · 重试 1/3')
    expect(document.body.textContent).toContain('抽取失败: docs/big.pdf')
  })

  it('没失败的任务仍然按详情文字识别:文件路径、笔记 id 是链接', async () => {
    backend({}, [
      job('j_ok1', 'ingest', 'done', { detail: 'docs/big.pdf', collection: 'proj_kb' }),
      job('j_ok2', 'evolve', 'done', { detail: '笔记 ins_8f21', collection: 'proj_kb' }),
    ])
    await open()
    expect($('[data-testid=job-cell-link]')?.textContent).toBe('docs/big.pdf')
    expect($('[data-testid=job-cell-insight-link]')?.textContent?.trim()).toBe('笔记 ins_8f21')
  })

  it('多文件详情展示为按钮,点击弹出文件清单对话框', async () => {
    backend({}, [job('j_multi', 'index', 'done', { detail: '3 个文件 (a.rs 等)', collection: 'proj_kb' })])
    await open()
    const btn = $('[data-testid=job-cell-files-btn]')
    expect(btn).not.toBeNull()
    expect(btn!.textContent).toBe('3 个文件 (a.rs 等)')
    btn!.click()
    await flushPromises()
    expect($('[data-testid=job-files-dialog]')).not.toBeNull()
  })

  it('详情卡展示涉及的文件区域,每个文件均有链接', async () => {
    await open()
    const section = $('[data-testid=job-files-section]')
    expect(section).not.toBeNull()
    expect(section!.textContent).toContain('src/a.rs')
  })

  it('改动的文件:标题、按变化的统计、写入块数;点「详情」展开错误全文', async () => {
    await open()
    const section = $('[data-testid=job-files-section]')!
    expect(section.textContent).toContain('改动的文件 (4 个)')
    expect($('[data-testid=job-files-counts]')!.textContent).toBe('新增 1 · 更新 1 · 未变化 1 · 失败 1')
    const rows = $$('[data-testid=job-files-changed] .kb-job-file')
    expect(rows).toHaveLength(4)
    const errorRow = rows.find((row) => row.textContent!.includes('src/c.rs'))!
    expect(errorRow.textContent).toContain('失败')
    expect(errorRow.textContent).toContain('处理失败')
    // 还没点开:没有块数明细,更没有错误全文
    expect(errorRow.querySelector('[data-testid=job-file-detail]')).toBeNull()
    ;(errorRow.querySelector('.kb-job-file-toggle') as HTMLButtonElement).click()
    await flushPromises()
    expect(errorRow.querySelector('[data-testid=job-file-detail]')!.textContent).toContain('写入 0')
    expect($('[data-testid=job-file-error]')!.textContent).toContain('permission denied: src/c.rs')
    // 再点一次收起
    ;(errorRow.querySelector('.kb-job-file-toggle') as HTMLButtonElement).click()
    await flushPromises()
    expect(errorRow.querySelector('[data-testid=job-file-detail]')).toBeNull()
  })

  it('老任务没有逐文件记录:退回任务参数里的清单并写明原因', async () => {
    filesByJob = {}
    await open()
    const section = $('[data-testid=job-files-section]')!
    expect(section.textContent).toContain('涉及的文件 (1 个)')
    expect(section.textContent).toContain('没有逐文件记录')
    expect(section.textContent).toContain('src/a.rs')
    expect($('[data-testid=job-files-counts]')).toBeNull()
  })

  it('文件多于一页:先显示 200 个,点「再显示」取下一页', async () => {
    filesByJob = { ...DEFAULT_FILES, j1: Array.from({ length: 205 }, (_, index) => ({ path: `src/f${index}.rs`, change: 'new' as const, chunks: 1, meta_chunks: 0, deleted_chunks: 0, error: null, done_at: T0 })) }
    await open()
    expect($$('[data-testid=job-files-changed] .kb-job-file')).toHaveLength(200)
    expect(lastArgs('job_files')).toEqual({ id: 'j1', page: 1, page_size: 200 })
    const more = [...$('[data-testid=job-files-section]')!.querySelectorAll('button')].find((button) => button.textContent!.includes('再显示'))!
    expect(more.textContent).toContain('再显示 5 个')
    more.click()
    await flushPromises()
    expect(lastArgs('job_files')).toEqual({ id: 'j1', page: 2, page_size: 200 })
    expect($$('[data-testid=job-files-changed] .kb-job-file')).toHaveLength(205)
  })
})
