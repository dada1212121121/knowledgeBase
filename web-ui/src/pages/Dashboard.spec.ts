// 系统概览:读取失败 / 没开通 / 后台刷新失败 / 某一块没读到,都不能是空白页或一排 0。
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  callCapability: (...args: unknown[]) => callCapability(...args),
}))
const push = vi.fn()
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
  useRouter: () => ({ push, replace: vi.fn() }),
  RouterLink: { props: ['to'], template: '<a class="router-link"><slot /></a>' },
}))
vi.mock('@/layouts/AppShell.vue', () => ({ default: { template: '<div class="app-shell"><slot /><slot name="actions" /></div>' } }))
type Live = (event: { type: string; data: Record<string, unknown> }) => void
const liveListeners = new Set<Live>()
const pushLive: Live = (event) => [...liveListeners].forEach((listener) => listener(event))
vi.mock('@/composables/useLiveEvents', () => ({
  useLiveEvents: (listener: Live) => {
    liveListeners.add(listener)
    return () => liveListeners.delete(listener)
  },
  subscribeLive: (listener: Live) => {
    liveListeners.add(listener)
    return () => liveListeners.delete(listener)
  },
}))

import { CapabilityError } from '@/api/client'
import { useSessionStore } from '@/stores/session'
import Dashboard from './Dashboard.vue'

const stats = {
  collections: [{ name: 'proj/insights', rows: 10 }],
  totals: { rows: 10, insights: 4, projects: 1 },
  jobs: { queued: 0, running: 0, paused: 0, done: 0, failed: 0, canceled: 0 },
  drafts_pending: 2,
  embedder: { id: 'bge-m3', dim: 1024, state: 'ready', error: null },
  reranker: { mode: 'local', available: true },
  recent_events: [],
  activity_7d: [],
}

let replies: Record<string, unknown> = {}
function backend(overrides: Record<string, unknown> = {}) {
  replies = {
    stats_overview: stats,
    job_list: { jobs: [] },
    audit_list: { entries: [], total: 0 },
    list_projects: { projects: [] },
    system_status: { components: [] },
    eval_history: { runs: [] },
    storage_overview: { disk: { free_gb: 100, reserve_gb: 10, paused: false, warn: false }, totals: { measured_spaces: 1, total_spaces: 1, total_bytes: 1, vectors_bytes: 0, oldest_measured_at: 0 }, top: [] },
    user_list: { users: [], total: 1, page: 1, page_size: 1 },
    ...overrides,
  }
  callCapability.mockImplementation(async (name: string) => {
    const reply = replies[name]
    if (reply instanceof Error) throw reply
    return reply ?? {}
  })
}
const $ = (selector: string) => document.body.querySelector<HTMLElement>(selector)
const text = () => document.body.textContent?.replace(/\s+/g, ' ').trim() ?? ''

let wrapper: VueWrapper | null = null
async function open(ai = true) {
  const session = useSessionStore()
  session.features = new Set(['sys.ops', 'sys.users'])
  session.aiEnabled = ai
  session.loaded = true
  wrapper = mount(Dashboard, { attachTo: document.body })
  await flushPromises()
}

beforeEach(() => {
  vi.useFakeTimers()
  liveListeners.clear()
  document.body.innerHTML = ''
  callCapability.mockReset()
  push.mockClear()
  setActivePinia(createPinia())
  backend()
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.useRealTimers()
})

describe('系统概览 · 读取状态', () => {
  it('读取成功:没有报错块', async () => {
    await open()
    expect($('[data-testid=admin-error]')).toBeNull()
    expect($('[data-testid=admin-forbidden]')).toBeNull()
    expect(text()).toContain('系统概览')
  })

  it('读不到整体数据:整页写清出了什么事,带重试;点重试后恢复', async () => {
    backend({ stats_overview: new CapabilityError('数据库繁忙', 'internal', 500) })
    await open()
    const box = $('[data-testid=admin-error]')
    expect(box).not.toBeNull()
    expect(box!.textContent).toContain('读取系统概览失败')
    expect(box!.textContent).toContain('重试')
    // 没有一排 0 和「读取中…」
    expect(text()).not.toContain('读取中')
    backend()
    box!.querySelector<HTMLButtonElement>('button')!.click()
    await flushPromises()
    expect($('[data-testid=admin-error]')).toBeNull()
  })

  it('没开通:说明没有开通,不给重试', async () => {
    backend({ stats_overview: new CapabilityError('forbidden', 'forbidden', 403) })
    await open()
    const box = $('[data-testid=admin-forbidden]')
    expect(box).not.toBeNull()
    expect(box!.textContent).toContain('你的账号没有开通这个功能')
    expect(box!.querySelector('button')).toBeNull()
  })

  it('读到过一次之后后台刷新失败:保留旧数据,只提示一句', async () => {
    await open()
    expect($('[data-testid=overview-stale]')).toBeNull()
    backend({ stats_overview: new CapabilityError('数据库繁忙', 'internal', 500) })
    await vi.advanceTimersByTimeAsync(15_000)
    await flushPromises()
    expect($('[data-testid=overview-stale]')).not.toBeNull()
    expect($('[data-testid=admin-error]')).toBeNull()
    // 恢复后提示消失
    backend()
    await vi.advanceTimersByTimeAsync(15_000)
    await flushPromises()
    expect($('[data-testid=overview-stale]')).toBeNull()
  })

  it('整体读到了、任务这一块读不到:任务卡写「没能读到」而不是「队列是空的」', async () => {
    backend({ job_list: new CapabilityError('服务繁忙', 'internal', 500) })
    await open()
    expect(text()).toContain('没能读到任务')
    expect(text()).not.toContain('队列是空的')
  })

  it('任务读得到但确实是空的:写「队列是空的」', async () => {
    await open()
    expect(text()).toContain('队列是空的')
    expect(text()).not.toContain('没能读到任务')
  })

  it('第一次读失败后,自动轮询读到了就自己恢复', async () => {
    backend({ stats_overview: new CapabilityError('服务繁忙', 'internal', 500) })
    await open()
    expect($('[data-testid=admin-error]')).not.toBeNull()
    backend()
    await vi.advanceTimersByTimeAsync(15_000)
    await flushPromises()
    expect($('[data-testid=admin-error]')).toBeNull()
  })
})

describe('系统概览 · 文案', () => {
  const rich = {
    stats_overview: { ...stats, recent_events: [{ id: 'ev1', kind: 'git_commit', project_id: null, payload_json: '{}', received_at: Date.now() - 60_000, processed_at: null, result: 'skipped_fingerprint' }] },
    job_list: {
      jobs: [
        { id: 'j1', kind: 'reindex', collection: 'other/docs', state: 'running', progress_done: 1, progress_total: 2, created_at: Date.now() - 9e4, started_at: Date.now() - 6e4, finished_at: null, detail: null, error: null },
        { id: 'j2', kind: 'evolve', collection: 'proj/insights', state: 'queued', progress_done: 0, progress_total: 0, created_at: Date.now() - 8e4, started_at: null, finished_at: null, detail: null, error: null },
      ],
    },
    audit_list: {
      entries: [
        { id: 1, at: Date.now() - 30_000, actor: 'usr_0123456789abcdef', capability: 'save_insight', args_json: '{"id":"ins_1","embedder":"bge-m3"}', ok: true, error: null, batch_id: null, dry_run: false },
        { id: 2, at: Date.now() - 20_000, actor: 'mcp:Claude Code', capability: 'agent_send', args_json: '{}', ok: true, error: null, batch_id: null, dry_run: false },
      ],
      total: 2,
    },
    system_status: {
      components: [
        { kind: 'embed', name: 'bge-m3', installed: true, ready: true, current: true, detail: null, model: null },
        { kind: 'llm', name: 'deepseek-chat', installed: true, ready: true, current: true, detail: 'API', model: null },
        { kind: 'review', name: 'qwen', installed: true, ready: true, current: true, detail: null, model: null },
        { kind: 'sidecar', name: 'onnx-sidecar', installed: true, ready: true, current: false, detail: null, model: null },
      ],
    },
    eval_history: { runs: [{ at: Date.now(), hit_at_k: 0.96, k: 5, mrr: 0.927 }] },
  }
  // onnx-sidecar 是组件的名字(数据),单独的 sidecar 才是不该露的内部词
  const INTERNAL = /(?<![-\w])sidecar(?![-\w])|LanceDB|Insights|\bhit@|\bMRR\b|\bP95\b|\bLLM\b|git_commit|save_insight|reindex|evolve|embedder|UTC/

  it('内部名字都换成了人话', async () => {
    backend(rich)
    await open()
    const page = text()
    expect(page).toContain('内容片段')
    expect(page).toContain('慢查询耗时')
    expect(page).toContain('前 5 条命中率')
    expect(page).toContain('平均排名得分')
    expect(page).toContain('重建索引')
    expect(page).toContain('提交了代码')
    expect(page).toContain('保存笔记')
    expect(page).toContain('编号 ins_1')
    expect(page).toContain('已建好')
    expect(page).not.toMatch(INTERNAL)
  })

  it('AI 总开关开着:待审核候选笔记、云端模型、自动提炼任务、助手对话都在', async () => {
    backend(rich)
    await open()
    const page = text()
    expect(page).toContain('待审核候选笔记')
    expect(page).toContain('云端模型')
    expect(page).toContain('审核模型')
    expect(page).toContain('自动提炼')
    expect(page).toContain('助手对话')
  })

  it('AI 总开关关掉:审核、云端模型、提炼任务、助手对话都不出现,页面没有「AI」字样', async () => {
    backend(rich)
    await open(false)
    const page = text()
    expect(page).not.toContain('待审核候选笔记')
    expect(page).not.toContain('去审核')
    expect(page).not.toContain('云端模型')
    expect(page).not.toContain('审核模型')
    expect(page).not.toContain('自动提炼')
    expect(page).not.toContain('助手对话')
    expect(page).not.toMatch(/\bAI\b/)
    // 本机模型照常显示
    expect(page).toContain('索引模型')
  })
})

describe('系统概览 · 列表卡的结构', () => {
  it('集合、任务、事件三张卡不用 table(手机上全局样式会把 table 拆散),行可以用键盘点开', async () => {
    backend({
      stats_overview: { ...stats, collections: [{ name: 'proj/insights', rows: 10 }, { name: 'proj/code', rows: 2 }] },
      job_list: { jobs: [{ id: 'j1', kind: 'ingest', collection: 'proj/code', state: 'queued', progress_done: 0, progress_total: 0, created_at: Date.now(), started_at: null, finished_at: null, detail: null, error: null }] },
    })
    await open()
    expect(document.body.querySelectorAll('table')).toHaveLength(0)
    const rows = [...document.body.querySelectorAll<HTMLButtonElement>('button.kb-ov-item')]
    expect(rows.map((row) => row.textContent!.replace(/\s+/g, ' ').trim())).toEqual([
      expect.stringContaining('proj/insights'),
      expect.stringContaining('proj/code'),
      expect.stringContaining('导入解析'),
    ])
    rows[0]!.click()
    expect(push).toHaveBeenCalledWith({ path: '/kb', query: { collection: 'proj/insights' } })
    rows[2]!.click()
    expect(push).toHaveBeenLastCalledWith('/tasks')
  })
})

describe('系统概览 · 内容片段占比', () => {
  const project = (name: string, rows: number) => ({ project: { name, id: `p_${name}` }, collection: `proj_${name}`, rows })

  it('每个项目一行:名字、内容片段数、占比;环中间是总数', async () => {
    backend({ list_projects: { projects: [project('knowledgeBase', 300), project('SampleApp', 100)] } })
    await open()
    const card = $('[data-testid=share-donut]')!
    expect(card).not.toBeNull()
    const rows = [...card.querySelectorAll('.kb-donut-row')].map((row) => [...row.querySelectorAll('.kb-donut-name, .kb-donut-num, .kb-donut-pct')].map((cell) => cell.textContent))
    expect(rows).toEqual([
      ['knowledgeBase', '300', '75%'],
      ['SampleApp', '100', '25%'],
    ])
    // 总数取全站的 totals.rows,不是项目之和(有的集合不属于任何项目)
    expect(card.querySelector('.kb-donut-value')!.textContent).toBe('10')
  })

  it('项目多了只列前几个,其余并成「其它 N 个项目」', async () => {
    backend({ list_projects: { projects: Array.from({ length: 9 }, (_, index) => project(`p${index}`, 100 - index)) } })
    await open()
    const names = [...document.body.querySelectorAll('[data-testid=share-donut] .kb-donut-name')].map((cell) => cell.textContent)
    expect(names).toHaveLength(6)
    expect(names.at(-1)).toBe('其它 4 个项目')
  })

  it('选了一个项目:只剩这个项目,环中间是它自己的总数', async () => {
    backend({ list_projects: { projects: [project('knowledgeBase', 300), project('SampleApp', 100)] } })
    await open()
    const picker = wrapper!.findAllComponents({ name: 'KbSelect' })[0]!
    picker.vm.$emit('update:modelValue', 'SampleApp')
    await flushPromises()
    const card = $('[data-testid=share-donut]')!
    expect([...card.querySelectorAll('.kb-donut-name')].map((cell) => cell.textContent)).toEqual(['SampleApp'])
    expect(card.querySelector('.kb-donut-value')!.textContent).toBe('100')
  })

  it('没有项目(或项目都是空的):不画空环,也不报错', async () => {
    backend({ list_projects: { projects: [project('empty', 0)] } })
    await open()
    expect($('[data-testid=share-donut]')).toBeNull()
  })
})

describe('系统概览 · 任务取数与刷新节奏(卡 A)', () => {
  const calls = (name: string) => callCapability.mock.calls.filter((call) => call[0] === name)
  const running = { id: 'j1', kind: 'reindex', collection: 'proj/insights', state: 'running', progress_done: 1, progress_total: 4, created_at: Date.now() - 9e4, started_at: Date.now() - 6e4, finished_at: null, detail: null, error: null }

  it('任务只取第一页 50 个,计数用 job_stats;AI 关掉时两者都排除提炼 / 审核类', async () => {
    backend({ job_stats: { by_state: { running: 3, queued: 120 } } })
    await open(false)
    expect(calls('job_list').at(-1)![1]).toEqual({ exclude_kinds: ['evolve', 'extract', 'review'], page_size: 50 })
    expect(calls('job_stats').at(-1)![1]).toEqual({ exclude_kinds: ['evolve', 'extract', 'review'] })
    // 计数以服务端统计为准(这一页里只有 0 个,统计说有 120 个排队)
    expect(text()).toContain('3 个运行中')
    expect(text()).toContain('120 个排队')
  })

  it('选了项目:任务按这个项目的集合重新取', async () => {
    backend({ list_projects: { projects: [{ project: { name: 'alpha', id: 'p_a' }, collection: 'proj_alpha', rows: 3 }] } })
    await open()
    const before = calls('job_list').length
    wrapper!.findAllComponents({ name: 'KbSelect' })[0]!.vm.$emit('update:modelValue', 'alpha')
    await flushPromises()
    expect(calls('job_list').length).toBe(before + 1)
    expect(calls('job_list').at(-1)![1]).toMatchObject({ collection: 'proj_alpha' })
  })

  it('列表里任务的进度推送只改进度,不整页重读;一串任务完成的推送合并成一次', async () => {
    backend({ job_list: { jobs: [running] }, stats_overview: { ...stats, collections: [{ name: 'proj/insights', rows: 10 }] } })
    await open()
    const before = calls('stats_overview').length
    pushLive({ type: 'job.progress', data: { job_id: 'j1', done: 3, total: 4 } })
    await vi.advanceTimersByTimeAsync(6_000)
    expect(calls('stats_overview').length).toBe(before)
    expect(text()).toContain('重建中 75%')
    for (let index = 0; index < 6; index++) {
      pushLive({ type: 'job.done', data: { job_id: `x${index}` } })
      await vi.advanceTimersByTimeAsync(300)
    }
    await vi.advanceTimersByTimeAsync(1_500)
    expect(calls('stats_overview').length).toBe(before + 1)
  })
})

describe('系统概览 · 趋势与本机资源(卡 F)', () => {
  it('页面最下面有活动趋势和本机资源两张卡;资源仪表用概览本来就取的系统状态', async () => {
    backend({ system_status: { components: [], resources: { cpu: { busy_ratio: 0.3, cores: 16 }, memory: { used_ratio: 0.85 }, disk: { used_ratio: 0.5, free_gb: 100 } } } })
    await open()
    expect($('[data-testid=activity-trend]')).not.toBeNull()
    const gauges = [...document.body.querySelectorAll('[data-testid=ov-resources] [role=img]')].map((item) => item.getAttribute('aria-label'))
    expect(gauges).toEqual(['处理器使用率:30%(16 核)', '内存使用率:85%(内存),偏高', '磁盘使用率:50%(剩 100 GB)'])
    // 没有为资源仪表多发请求:系统状态只取了一次
    expect(callCapability.mock.calls.filter((call) => call[0] === 'system_status')).toHaveLength(1)
  })

  it('整页读不到时不出现这两张卡', async () => {
    backend({ stats_overview: new CapabilityError('数据库繁忙', 'internal', 500) })
    await open()
    expect($('[data-testid=activity-trend]')).toBeNull()
    expect($('[data-testid=ov-resources]')).toBeNull()
  })
})
