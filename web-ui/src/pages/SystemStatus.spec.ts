// 系统状态页:五页(服务 / 资源 / 组件 / 任务 / 日志)、各块独立容错、四种状态、AI 关闭时隐藏相关内容、自动刷新。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { reactive } from 'vue'

const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  callCapability: (...args: unknown[]) => callCapability(...args),
}))
const replace = vi.fn()
const route = reactive<{ path: string; query: Record<string, string> }>({ path: '/admin/system', query: {} })
vi.mock('vue-router', () => ({
  useRoute: () => route,
  useRouter: () => ({ push: vi.fn(), replace }),
  RouterLink: { name: 'RouterLink', props: ['to'], template: '<a class="router-link" :data-to="JSON.stringify(to)"><slot /></a>' },
}))
vi.mock('@/layouts/AppShell.vue', () => ({ default: { template: '<div class="app-shell"><slot /></div>' } }))

import { CapabilityError } from '@/api/client'
import { useSessionStore } from '@/stores/session'
import type { SystemSnapshot } from '@/utils/systemStatus'
import SystemStatus from './SystemStatus.vue'

const NOW = Date.UTC(2026, 9, 20, 4, 42, 0)
const SNAPSHOT: SystemSnapshot = {
  overview: { service: { version: '0.4.0', uptime_seconds: 3 * 86400 + 4 * 3600 + 600, home: '/data/kb', listen: '127.0.0.1:7878' }, collections: 7, projects: 3, sources: 2, components_ready: [4, 4], note: null },
  resources: {
    cpu: { cores: 8, busy_ratio: 0.21, load: [0.8, 0.7, 0.6] },
    memory: { total_mb: 32768, available_mb: 18000, used_ratio: 0.45 },
    disk: { mount: '/data', free_gb: 22, total_gb: 100, used_ratio: 0.78 },
    gpu: { name: 'Intel Iris Xe', utilization: null, memory_used_mb: null, note: 'GPU 利用率 / 显存未采集' },
  },
  components: [
    { kind: 'embed', id: 'bge-m3', name: 'bge-m3 · ONNX', installed: true, ready: true, current: true, detail: '核显', model: null },
    { kind: 'rerank', id: 'bge-reranker', name: 'bge-reranker-v2-m3', installed: true, ready: true, current: true, detail: '核显', model: null },
    { kind: 'ocr', id: 'rapidocr', name: 'RapidOCR', installed: false, ready: false, current: true, detail: '找不到命令 rapidocr', model: null },
    { kind: 'llm', id: 'deepseek', name: 'deepseek-chat', installed: true, ready: true, current: true, detail: '云端', model: null },
    { kind: 'review', id: 'qwen', name: 'qwen2.5-14b', installed: true, ready: true, current: true, detail: '未加载', model: null },
  ],
  env: { cpu_cores: 8, memory_mb: 32768, has_nvidia: false, gpu: 'Intel Iris Xe', has_intel_gpu: true, tools: ['git', 'node'] },
  jobs: {
    by_state: [['queued', 2], ['running', 1], ['paused', 0], ['done', 42], ['failed', 1], ['canceled', 0]],
    recent: [
      { id: 'j1', kind: 'index', state: 'running', done: 41, total: 100, updated_at: NOW - 5 * 60_000 },
      { id: 'j2', kind: 'evolve', state: 'done', done: 1, total: 1, updated_at: NOW - 3_600_000 * 3 },
      { id: 'j3', kind: 'embed', state: 'failed', done: 0, total: null, updated_at: NOW - 3_600_000 * 30 },
    ],
    ingest: [['queued', 0], ['embedding', 3], ['done', 120], ['failed', 2]],
  },
  network: { listen: '127.0.0.1:7878', socket: '/data/kb/run/kb.sock', allow_remote: false, mcp_transports: ['stdio', 'http'], mcp_allowed_hosts: [], llm_calls_today: 18, llm_tokens_today: [182_000, 41_000] },
  logs: {
    dir: '/data/kb/logs',
    files: [['kbd.log', 2048]],
    tail: ['00:22:04 INFO  reindex start', '00:23:40 WARN  chunk doc_0441 truncated', '00:24:10 INFO  mentions WARN in text', '00:25:11 ERROR embed failed: sidecar timeout', 'plain stack line'],
  },
}

let replies: Record<string, unknown> = {}
function backend(overrides: Record<string, unknown> = {}) {
  replies = { system_status: SNAPSHOT, ...overrides }
  callCapability.mockImplementation(async (name: string) => {
    const reply = replies[name]
    if (reply instanceof Error) throw reply
    if (typeof reply === 'function') return (reply as () => unknown)()
    return reply ?? {}
  })
}
const calls = (name: string) => callCapability.mock.calls.filter((call) => call[0] === name)
const $ = <T extends Element = HTMLElement>(selector: string) => document.body.querySelector<T>(selector)
const $$ = (selector: string) => [...document.body.querySelectorAll<HTMLElement>(selector)]
const text = () => document.body.textContent!.replace(/\s+/g, ' ')
const clickTab = async (label: string) => {
  ;[...document.body.querySelectorAll<HTMLElement>('[role=tab]')].find((item) => item.textContent!.includes(label))!.click()
  await flushPromises()
}

let wrapper: VueWrapper | null = null
const errors: unknown[] = []
async function open(options: { ai?: boolean; features?: string[]; tab?: string } = {}) {
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia
  const session = useSessionStore()
  session.features = new Set(options.features ?? ['sys.ops', 'sys.settings'])
  session.aiEnabled = options.ai ?? true
  session.loaded = true
  route.query = options.tab ? { tab: options.tab } : {}
  wrapper = mount(SystemStatus, { attachTo: document.body, global: { config: { errorHandler: (err) => errors.push(err) } } })
  await flushPromises()
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(NOW)
  wrapper?.unmount()
  wrapper = null
  errors.length = 0
  document.body.innerHTML = ''
  callCapability.mockReset()
  replace.mockReset()
  setActivePinia(createPinia())
  backend()
})
afterEach(() => vi.useRealTimers())

describe('系统状态 · 服务', () => {
  it('五个页签;默认是「服务」,有服务信息 / 数据规模 / 网络与访问 / 云端模型用量四张卡', async () => {
    await open()
    expect(errors).toEqual([])
    expect($$('[role=tab]').map((item) => item.textContent!.trim())).toEqual(['服务', '资源', '组件', '任务', '日志'])
    expect($$('[data-testid^=card-]').map((item) => item.dataset.testid)).toEqual(['card-service', 'card-scale', 'card-network', 'card-llm'])
    expect($('[data-testid=row-version]')!.textContent).toContain('0.4.0')
    expect($('[data-testid=row-uptime]')!.textContent).toContain('3 天 4 小时')
    expect($('[data-testid=row-collections]')!.textContent).toContain('7 个')
    expect($('[data-testid=status-updated]')!.textContent).toContain('更新于')
  })

  it('网络里不再有编出来的内容(Nginx、协议版本号),缺的值写「—」', async () => {
    backend({ system_status: { ...SNAPSHOT, network: { ...SNAPSHOT.network, mcp_transports: [], socket: undefined } } })
    await open()
    const all = text()
    expect(all).not.toMatch(/Nginx|2024-11|Unix Domain|LlmGate|端口与到达性/)
    expect($('[data-testid=row-transports]')!.textContent).toContain('—')
    expect($('[data-testid=row-socket]')!.textContent).toContain('—')
    expect($('[data-testid=row-hosts]')!.textContent).toContain('只允许本机访问')
  })

  it('每一行是中文标签 + 帮助文字,键名放在帮助文字里', async () => {
    await open()
    const row = $('[data-testid=row-remote]')!
    expect(row.querySelector('dt')!.firstChild!.textContent!.trim()).toBe('允许远程访问')
    expect(row.querySelector('small')!.textContent).toContain('server.allow_remote')
    expect(row.querySelector('dd')!.textContent).toContain('已关闭')
  })

  it('有没就绪的组件 / 失败的任务:顶上「需要注意」说一句', async () => {
    await open()
    const notes = $('[data-testid=status-notes]')!
    expect(notes.textContent).toContain('RapidOCR')
    expect(notes.textContent).toContain('有 1 个任务失败了')
  })

  it('一切正常就没有「需要注意」', async () => {
    backend({ system_status: { ...SNAPSHOT, components: SNAPSHOT.components!.map((item) => ({ ...item, ready: true, installed: true })), jobs: { ...SNAPSHOT.jobs, by_state: [['done', 3]] } } })
    await open()
    expect($('[data-testid=status-notes]')).toBeNull()
  })

  it('旧地址 ?tab=network / overview 进「服务」,认不出的取值也回到「服务」', async () => {
    await open({ tab: 'network' })
    expect($('[data-testid=card-network]')).not.toBeNull()
    wrapper!.unmount()
    await open({ tab: 'bogus' })
    expect($('[data-testid=card-service]')).not.toBeNull()
    expect($('[role=tab][aria-selected=true]')!.textContent).toContain('服务')
  })

  it('切页签:写进地址的 ?tab=,并显示对应内容', async () => {
    await open()
    await clickTab('资源')
    expect(replace).toHaveBeenCalledWith({ query: { tab: 'resources' } })
    expect($('[data-testid=card-cpu]')).not.toBeNull()
    expect($('[data-testid=card-service]')).toBeNull()
  })
})

describe('系统状态 · 资源', () => {
  it('处理器 / 内存 / 磁盘 / 显卡 / 加速与工具;没采集的写「未采集」', async () => {
    await open({ tab: 'resources' })
    expect($$('[data-testid^=card-]').map((item) => item.dataset.testid)).toEqual(['card-cpu', 'card-memory', 'card-disk', 'card-gpu', 'card-env'])
    expect($('[data-testid=row-busy]')!.textContent).toContain('21%')
    expect($('[data-testid=row-load]')!.textContent).toContain('0.80 / 0.70 / 0.60')
    expect($('[data-testid=card-gpu]')!.textContent).toContain('未采集')
    expect($('[data-testid=card-gpu]')!.textContent).toContain('GPU 利用率 / 显存未采集')
    expect($('[data-testid=row-free]')!.textContent).toContain('22 GB / 100 GB')
    // 78% 还不到「偏高」
    expect($('[data-testid=level-disk]')).toBeNull()
  })

  it('不再有三个数拼成的「负载走势图」和写死的「CPU / ONNX Runtime」说明;处理器卡里是环形仪表', async () => {
    await open({ tab: 'resources' })
    expect(text()).not.toContain('负载走势图')
    expect(text()).not.toContain('ONNX Runtime')
    expect($('[data-testid=card-cpu] [role=img]')!.getAttribute('aria-label')).toContain('处理器使用率')
  })

  it('磁盘到 93%:红色仪表 + 文字「快满了」(不只靠颜色)', async () => {
    backend({ system_status: { ...SNAPSHOT, resources: { ...SNAPSHOT.resources, disk: { mount: '/data', free_gb: 7, total_gb: 100, used_ratio: 0.93 } } } })
    await open({ tab: 'resources' })
    expect($('[data-testid=level-disk]')!.textContent).toBe('快满了')
    expect($('[data-testid=level-disk]')!.classList.contains('r')).toBe(true)
    expect($('[data-testid=card-disk] [role=img]')!.getAttribute('aria-label')).toBe('磁盘使用率:93%,接近上限')
    expect($('[data-testid=card-disk] .kb-gauge')!.classList.contains('is-danger')).toBe(true)
  })

  it('内存 85%:提示「偏高」', async () => {
    backend({ system_status: { ...SNAPSHOT, resources: { ...SNAPSHOT.resources, memory: { total_mb: 100, available_mb: 15, used_ratio: 0.85 } } } })
    await open({ tab: 'resources' })
    expect($('[data-testid=level-memory]')!.textContent).toBe('偏高')
  })

  it('资源块没读到:只有资源卡片显示「没读到」,「加速与工具」照常', async () => {
    backend({ system_status: { ...SNAPSHOT, resources: undefined } })
    await open({ tab: 'resources' })
    expect($('[data-testid=block-missing]')!.getAttribute('data-block')).toBe('资源用量')
    expect($('[data-testid=card-env]')).not.toBeNull()
    expect($('[data-testid=card-cpu]')).toBeNull()
  })
})

describe('系统状态 · 组件', () => {
  it('按种类分组,用中文种类名;状态写文字;当前使用的有徽标', async () => {
    await open({ tab: 'components' })
    expect($$('[data-testid^=kind-]').map((item) => item.dataset.testid)).toEqual(['kind-ocr', 'kind-embed', 'kind-rerank', 'kind-llm', 'kind-review'])
    expect($('[data-testid=kind-ocr]')!.textContent).toContain('文字识别(OCR)')
    expect($('[data-testid=kind-ocr]')!.textContent).toContain('未安装')
    expect($('[data-testid=kind-ocr]')!.textContent).toContain('找不到命令 rapidocr')
    expect($('[data-testid=kind-embed]')!.textContent).toContain('当前使用')
    expect($('[data-testid=kind-embed]')!.textContent).toContain('索引模型')
    expect($('[data-testid=components-summary]')!.textContent).toContain('有组件没就绪')
    expect($('[data-testid=components-summary]')!.textContent).toContain('4 / 5 个组件就绪')
  })

  it('有系统设置功能才给「去系统设置装组件」的链接,并且带上 ?tab=components', async () => {
    await open({ tab: 'components' })
    expect(JSON.parse($('[data-testid=components-link] a')!.getAttribute('data-to')!)).toEqual({ path: '/admin/settings', query: { tab: 'components' } })
    wrapper!.unmount()
    await open({ tab: 'components', features: ['sys.ops'] })
    expect($('[data-testid=components-link]')).toBeNull()
  })

  it('没有任何组件:给说明,不说「全部就绪」,不是空白', async () => {
    backend({ system_status: { ...SNAPSHOT, components: [] } })
    await open({ tab: 'components' })
    expect(text()).toContain('没有检测到组件')
    expect($('[data-testid=components-summary]')).toBeNull()
    expect(text()).not.toContain('全部就绪')
  })

  it('组件块没读到:只有这一块显示「没读到」,点「重新读取」会再请求一次', async () => {
    backend({ system_status: { ...SNAPSHOT, components: undefined } })
    await open({ tab: 'components' })
    const missing = $('[data-testid=block-missing]')!
    expect(missing.textContent).toContain('「组件」这一块没有读到')
    expect(missing.textContent).toContain('其它部分不受影响')
    backend()
    ;[...missing.querySelectorAll('button')].find((item) => item.textContent!.includes('重新读取'))!.click()
    await flushPromises()
    expect(calls('system_status')).toHaveLength(2)
    expect($('[data-testid=block-missing]')).toBeNull()
    expect($('[data-testid=kind-embed]')).not.toBeNull()
  })
})

describe('系统状态 · 任务', () => {
  it('任务队列用中文状态;导入队列只列有文件的;最近任务用中文类型', async () => {
    await open({ tab: 'jobs' })
    const queue = $('[data-testid=card-queue]')!.textContent!
    for (const word of ['排队', '运行中', '完成', '失败', '已暂停']) expect(queue).toContain(word)
    expect(queue).not.toMatch(/queued|running|failed/)
    expect(queue).toContain('共 46 个')
    const ingest = $('[data-testid=card-ingest]')!.textContent!
    expect(ingest).toContain('建立索引')
    expect(ingest).not.toContain('排队')
    const recent = $$('[data-testid=recent-job]').map((item) => item.textContent!.replace(/\s+/g, ' '))
    expect(recent[0]).toContain('运行中')
    expect(recent[0]).toContain('索引')
    expect(recent[0]).toContain('41 / 100')
    expect(recent[2]).toContain('建立索引')
    expect(recent[2]).toContain('0 / ?')
  })

  it('不再有写死的「工作线程」「吞吐与限流」「队列健康度」(重复且是编的)', async () => {
    await open({ tab: 'jobs' })
    expect(text()).not.toMatch(/Tokio|Worker|Checkpoint|指数退避|并发槽位|队列健康度|吞吐与限流/)
    expect($$('[data-testid^=card-]').map((item) => item.dataset.testid)).toEqual(['card-queue', 'card-ingest', 'card-recent'])
  })

  it('导入队列是空的:写一句说明,不是空卡片', async () => {
    backend({ system_status: { ...SNAPSHOT, jobs: { ...SNAPSHOT.jobs, ingest: [['queued', 0], ['done', 0]] } } })
    await open({ tab: 'jobs' })
    expect($('[data-testid=ingest-idle]')!.textContent).toContain('导入队列是空的')
  })

  it('还没有任何任务:最近的任务给空状态和「去导入」', async () => {
    backend({ system_status: { ...SNAPSHOT, jobs: { by_state: [], recent: [], ingest: [] } } })
    await open({ tab: 'jobs' })
    const card = $('[data-testid=card-recent]')!
    expect(card.textContent).toContain('还没有任务')
    expect(JSON.parse(card.querySelector('a')!.getAttribute('data-to')!)).toBe('/import')
  })

  it('任务块没读到(jobs.recent 不是数组):只有任务页显示「没读到」,切到别的页签照常', async () => {
    backend({ system_status: { ...SNAPSHOT, jobs: { by_state: [], recent: null, ingest: [] } } })
    await open({ tab: 'jobs' })
    expect($('[data-testid=block-missing]')!.getAttribute('data-block')).toBe('任务')
    await clickTab('资源')
    expect($('[data-testid=card-cpu]')).not.toBeNull()
    expect($('[data-testid=block-missing]')).toBeNull()
  })
})

describe('系统状态 · 日志', () => {
  it('警告和错误分开标:错误红、警告黄,正文里碰巧有 WARN 的不算;尾部是可滚动的区域', async () => {
    await open({ tab: 'logs' })
    const problems = $$('[data-testid=problem]').map((item) => item.textContent!.replace(/\s+/g, ' ').trim())
    expect(problems).toHaveLength(2)
    expect(problems[0]).toContain('警告')
    expect(problems[0]).toContain('chunk doc_0441 truncated')
    expect(problems[1]).toContain('错误')
    expect($$('[data-testid=problem] .tag').map((item) => item.classList.contains('r'))).toEqual([false, true])
    const tail = $('[data-testid=log-tail]')!
    expect(tail.getAttribute('role')).toBe('region')
    expect(tail.getAttribute('tabindex')).toBe('0')
    expect(tail.textContent).toContain('plain stack line')
    expect($('[data-testid=card-files]')!.textContent).toContain('kbd.log')
    expect($('[data-testid=card-files]')!.textContent).toContain('2 KB')
  })

  it('没有日志文件 / 没有告警 / 没有输出:各写一句,不是空卡片', async () => {
    backend({ system_status: { ...SNAPSHOT, logs: { dir: '/x', files: [], tail: [] } } })
    await open({ tab: 'logs' })
    expect($('[data-testid=files-none]')!.textContent).toContain('还没有日志文件')
    expect($('[data-testid=problems-none]')!.textContent).toContain('没有警告或错误')
    expect($('[data-testid=tail-none]')!.textContent).toContain('还没有日志输出')
  })

  it('不再有写死的「默认级别 INFO」和没有对应功能的「诊断包清单」', async () => {
    await open({ tab: 'logs' })
    expect(text()).not.toMatch(/诊断包|默认级别|排障诊断/)
    expect($('[data-testid=card-files]')!.textContent).toContain('config.toml')
  })

  it('日志块没读到:只有日志页显示「没读到」', async () => {
    backend({ system_status: { ...SNAPSHOT, logs: undefined } })
    await open({ tab: 'logs' })
    expect($('[data-testid=block-missing]')!.getAttribute('data-block')).toBe('日志')
    await clickTab('服务')
    expect($('[data-testid=card-service]')).not.toBeNull()
  })

  it('服务页:网络块没读到,服务信息和数据规模照常', async () => {
    backend({ system_status: { ...SNAPSHOT, network: undefined } })
    await open()
    expect($('[data-testid=block-missing]')!.getAttribute('data-block')).toBe('网络与访问')
    expect($('[data-testid=card-service]')).not.toBeNull()
    expect($('[data-testid=card-scale]')).not.toBeNull()
    // 云端模型用量也在网络块里,一起没有
    expect($('[data-testid=card-llm]')).toBeNull()
  })
})

describe('系统状态 · 四种状态与刷新', () => {
  it('第一次读取时是骨架屏,页签和标题已经在', async () => {
    let release!: (value: unknown) => void
    backend({ system_status: () => new Promise((resolve) => (release = resolve)) })
    await open()
    expect($('[data-testid=admin-loading]')).not.toBeNull()
    expect(text()).toContain('系统状态')
    expect($$('[role=tab]')).toHaveLength(5)
    release(SNAPSHOT)
    await flushPromises()
    expect($('[data-testid=admin-loading]')).toBeNull()
    expect($('[data-testid=card-service]')).not.toBeNull()
  })

  it('读不到:内容区报错说清楚并给重试,标题和页签还在,点重试恢复', async () => {
    backend({ system_status: new CapabilityError('internal: 数据库正忙', 'internal', 500) })
    await open()
    const alert = $('[data-testid=admin-error]')!
    expect(alert.textContent).toContain('读取系统状态失败:数据库正忙')
    expect(alert.textContent).toContain('守护进程')
    expect(alert.textContent).not.toContain('internal')
    expect(text()).toContain('系统状态')
    expect($$('[role=tab]')).toHaveLength(5)
    backend()
    ;[...alert.querySelectorAll('button')].find((item) => item.textContent!.includes('重试'))!.click()
    await flushPromises()
    expect($('[data-testid=admin-error]')).toBeNull()
    expect($('[data-testid=card-service]')).not.toBeNull()
  })

  it('读不到时 10 秒后自动再试,读到了就恢复', async () => {
    backend({ system_status: new CapabilityError('internal: 忙', 'internal', 500) })
    await open()
    expect($('[data-testid=admin-error]')).not.toBeNull()
    backend()
    vi.advanceTimersByTime(10_000)
    await flushPromises()
    expect($('[data-testid=admin-error]')).toBeNull()
    expect($('[data-testid=card-service]')).not.toBeNull()
  })

  it('服务端 403:无权限,不给重试,不再轮询', async () => {
    backend({ system_status: new CapabilityError('你的账号没有开通这个功能', 'forbidden', 403) })
    await open()
    expect($('[data-testid=admin-forbidden]')!.textContent).toContain('你的账号没有开通这个功能')
    expect($('[data-testid=admin-error]')).toBeNull()
    expect($('[data-testid=status-refresh]')).toBeNull()
  })

  it('账号没有「系统运维」功能:直接说明,不请求接口', async () => {
    await open({ features: ['docs.notes'] })
    expect($('[data-testid=admin-forbidden]')).not.toBeNull()
    expect(calls('system_status')).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('读到之后自动刷新失败:数据留着,提示显示的是几点的数据;再成功就消失', async () => {
    await open()
    backend({ system_status: new CapabilityError('internal: 忙', 'internal', 500) })
    vi.advanceTimersByTime(10_000)
    await flushPromises()
    expect($('[data-testid=card-service]')).not.toBeNull()
    expect($('[data-testid=admin-error]')).toBeNull()
    const stale = $('[data-testid=status-stale]')!
    expect(stale.textContent).toContain('显示的是')
    expect(stale.textContent).toContain('的数据')
    backend()
    vi.advanceTimersByTime(10_000)
    await flushPromises()
    expect($('[data-testid=status-stale]')).toBeNull()
  })

  it('读到之后角色被收回(403):不再展示旧数据', async () => {
    await open()
    backend({ system_status: new CapabilityError('你的账号没有开通这个功能', 'forbidden', 403) })
    vi.advanceTimersByTime(10_000)
    await flushPromises()
    expect($('[data-testid=admin-forbidden]')).not.toBeNull()
    expect($('[data-testid=card-service]')).toBeNull()
  })

  it('每 10 秒自动刷新一次;上一次还没回来不会叠着发;卸载后停掉', async () => {
    let release!: (value: unknown) => void
    await open()
    expect(calls('system_status')).toHaveLength(1)
    backend({ system_status: () => new Promise((resolve) => (release = resolve)) })
    vi.advanceTimersByTime(10_000)
    expect(calls('system_status')).toHaveLength(2)
    vi.advanceTimersByTime(10_000)
    expect(calls('system_status')).toHaveLength(2)
    release(SNAPSHOT)
    await flushPromises()
    wrapper!.unmount()
    wrapper = null
    expect(vi.getTimerCount()).toBe(0)
  })

  it('页面在后台时不自动刷新,回到前台的下一拍继续', async () => {
    await open()
    let hidden = true
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') })
    try {
      vi.advanceTimersByTime(10_000)
      await flushPromises()
      expect(calls('system_status')).toHaveLength(1)
      hidden = false
      vi.advanceTimersByTime(10_000)
      await flushPromises()
      expect(calls('system_status')).toHaveLength(2)
    } finally {
      Reflect.deleteProperty(document, 'visibilityState')
    }
  })

  it('刷新按钮:读取中禁用并写「刷新中…」', async () => {
    await open()
    let release!: (value: unknown) => void
    backend({ system_status: () => new Promise((resolve) => (release = resolve)) })
    const button = $<HTMLButtonElement>('[data-testid=status-refresh]')!
    button.click()
    await flushPromises()
    expect(button.disabled).toBe(true)
    expect(button.textContent).toContain('刷新中')
    release(SNAPSHOT)
    await flushPromises()
    expect(button.disabled).toBe(false)
  })
})

describe('系统状态 · 刷新页面时会话稍后才取回来', () => {
  it('先按「有权限」读取并开始轮询,会话取回来发现没有这个功能:切成未开通、丢掉旧数据、停掉轮询', async () => {
    await open()
    expect($('[data-testid=card-service]')).not.toBeNull()
    const session = useSessionStore()
    session.features = new Set(['docs.notes'])
    await flushPromises()
    expect($('[data-testid=admin-forbidden]')).not.toBeNull()
    expect($('[data-testid=card-service]')).toBeNull()
    expect($('[data-testid=status-refresh]')).toBeNull()
    const before = calls('system_status').length
    vi.advanceTimersByTime(30_000)
    await flushPromises()
    expect(calls('system_status')).toHaveLength(before)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('一开始没有功能,管理员稍后开通:自动开始读取', async () => {
    await open({ features: ['docs.notes'] })
    expect(calls('system_status')).toHaveLength(0)
    useSessionStore().features = new Set(['sys.ops'])
    await flushPromises()
    expect(calls('system_status')).toHaveLength(1)
    expect($('[data-testid=card-service]')).not.toBeNull()
    expect(vi.getTimerCount()).toBe(1)
  })
})

describe('系统状态 · AI 关闭', () => {
  it('服务页:没有云端模型用量,页面任何位置没有「AI」字样', async () => {
    await open({ ai: false })
    expect($('[data-testid=card-llm]')).toBeNull()
    expect(text()).not.toMatch(/AI|\bai\b/)
    expect(text()).not.toContain('云端模型')
  })

  it('每个页签都没有「AI」字样,也没有云端模型 / 审核模型 / 自动提炼的任务', async () => {
    await open({ ai: false })
    for (const label of ['服务', '资源', '组件', '任务', '日志']) {
      await clickTab(label)
      expect(text(), label).not.toMatch(/AI|自动提炼|云端模型|审核模型/)
    }
  })

  it('组件页:云端模型和审核模型不出现,就绪数按剩下的算', async () => {
    await open({ ai: false, tab: 'components' })
    expect($('[data-testid=kind-llm]')).toBeNull()
    expect($('[data-testid=kind-review]')).toBeNull()
    expect($('[data-testid=components-summary]')!.textContent).toContain('2 / 3 个组件就绪')
  })

  it('任务页:自动提炼类的任务不出现在最近任务里', async () => {
    await open({ ai: false, tab: 'jobs' })
    const recent = $$('[data-testid=recent-job]')
    expect(recent).toHaveLength(2)
    expect(recent.map((item) => item.textContent).join('')).not.toContain('自动提炼')
  })

  it('AI 开着时这些都在', async () => {
    await open({ ai: true, tab: 'jobs' })
    expect($$('[data-testid=recent-job]').map((item) => item.textContent).join('')).toContain('自动提炼')
    wrapper!.unmount()
    await open({ ai: true })
    expect($('[data-testid=card-llm]')!.textContent).toContain('18 次')
    expect($('[data-testid=card-llm]')!.textContent).toContain('18.2 万')
  })
})
