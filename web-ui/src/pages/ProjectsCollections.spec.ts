// 项目与集合页里「项目」卡片和「集合」表的行为(服务器目录与 Git 来源那一块另见 Projects.spec.ts)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { PHONE_QUERY, type ConfirmOptions } from '@kb-ui/index'
import { toasts } from '@kb-ui/components/useToast'

const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  callCapability: (...args: unknown[]) => callCapability(...args),
}))
const push = vi.fn()
vi.mock('vue-router', () => ({ useRoute: () => ({ path: '/admin/projects', query: {} }), useRouter: () => ({ push, replace: vi.fn() }) }))
vi.mock('@/layouts/AppShell.vue', () => ({ default: { template: '<div class="app-shell"><slot /></div>' } }))
const ask = vi.fn()
vi.mock('@kb-ui/index', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kb-ui/index')>()),
  useConfirm: () => ({ ask: (options: ConfirmOptions) => ask(options) }),
}))

import { CapabilityError } from '@/api/client'
import { useSessionStore } from '@/stores/session'
import Projects from './Projects.vue'

const project = (name: string, over: Record<string, unknown> = {}) => ({
  project: {
    id: `p_${name}`,
    name,
    slug: name,
    root_path: `/srv/workspace/${name}`,
    include: ['src/**', 'docs/**'],
    exclude: ['target/**'],
    is_git: true,
    last_commit: null,
    last_indexed_at: Date.UTC(2026, 9, 20, 4, 30),
    allow_cloud_llm: true,
    extract_enabled: true,
    hooks_installed: true,
    created_at: 1,
    ...over,
  },
  collection: name,
  rows: 100,
})
const coll = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  kind: 'project',
  project_id: 'p1',
  embedder_id: 'fastembed:bge-m3-int8',
  dim: 1024,
  active_table: `${name.replace('/', '_')}__v1`,
  rows: 1000,
  migrating_to: null,
  ...over,
})
const PROJECTS = [project('knowledgeBase'), project('SampleApp', { hooks_installed: false, allow_cloud_llm: false, extract_enabled: false, include: [], exclude: [], last_indexed_at: null })]
const COLLECTIONS = [coll('knowledgeBase/code', { rows: 3112 }), coll('knowledgeBase/insights', { rows: 482 }), coll('SampleApp/code', { migrating_to: 'fastembed:bge-m3-q8', rows: 4206 }), coll('_global/外部资料', { rows: 1206 })]
const JOBS = [{ id: 'job_mig', kind: 'migrate', collection: 'SampleApp/code', state: 'running', progress_done: 41, progress_total: 100, rate: null, error: null, created_at: 1, started_at: 1, finished_at: null }]
const PLAN = { collection: 'knowledgeBase/code', to_table: 'kb_code__v2', from_embedder: 'fastembed:bge-m3-int8', to_embedder: 'fastembed:bge-m3', rows: 5100, insight_rows: 390, estimated_seconds: 96, can_switch_without_reembed: false }

let replies: Record<string, unknown> = {}
function backend(overrides: Record<string, unknown> = {}) {
  replies = {
    list_sources: { sources: [], items: [] },
    list_collections: { collections: COLLECTIONS },
    list_projects: { projects: PROJECTS },
    stats_overview: { embedder: { id: 'fastembed:bge-m3-int8' } },
    job_list: { jobs: JOBS },
    list_ingest: { total: 0, files: [] },
    get_config: {},
    system_status: {},
    update_project: { project: {}, job_id: null },
    reindex_project: { job_id: 'j1' },
    install_hooks: {},
    uninstall_hooks: {},
    add_project: {},
    remove_project: {},
    delete_collection: {},
    migrate_plan: PLAN,
    migrate_model: { job_id: 'j_migrate' },
    ...overrides,
  }
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
const button = (root: ParentNode, label: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent!.includes(label))!
const card = (name: string) => $(`[data-testid=project-card][data-project=${name}]`)!
const toastTexts = () => toasts.map((entry) => entry.message)
/** 最新的一条提示(toasts 队列新的在前) */
const latestToast = () => toasts[0]?.message
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((ok) => (resolve = ok))
  return { promise, resolve }
}

let wrapper: VueWrapper | null = null
const errors: unknown[] = []
async function open(options: { phone?: boolean; ai?: boolean; features?: string[] } = {}) {
  window.matchMedia = ((query: string) => ({ matches: !!options.phone && query === PHONE_QUERY, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia
  const session = useSessionStore()
  session.aiEnabled = options.ai ?? true
  if (options.features) {
    session.features = new Set(options.features)
    session.loaded = true
  }
  // Vue 会「接住」挂载钩子里的异步异常;不装 errorHandler 它就变成未处理的 Promise 拒绝(让 vitest 退出码变 1)
  wrapper = mount(Projects, { attachTo: document.body, global: { config: { errorHandler: (err) => errors.push(err) } } })
  await flushPromises()
  await flushPromises()
}

/** 模拟用户在确认框里点「确认」(有 action 就先执行,和真实 useConfirm 一致)或「取消」。 */
function answer(yes: boolean) {
  ask.mockImplementation(async (options: ConfirmOptions) => {
    if (!yes) return false
    await options.action?.()
    return true
  })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(Date.UTC(2026, 9, 20, 4, 42))
  wrapper?.unmount()
  wrapper = null
  errors.length = 0
  toasts.splice(0)
  document.body.innerHTML = ''
  callCapability.mockReset()
  push.mockReset()
  ask.mockReset()
  answer(true)
  setActivePinia(createPinia())
  backend()
})
afterEach(() => vi.useRealTimers())

describe('Projects · 读取容错', () => {
  it('概览里没有 embedder 字段(或概览读不到):页面照常显示,不抛异常', async () => {
    backend({ stats_overview: { totals: { rows: 0 } } })
    await open()
    expect(errors).toEqual([])
    expect(document.body.textContent).toContain('项目与集合')

    wrapper!.unmount()
    backend({ stats_overview: new Error('boom') })
    await open()
    expect(errors).toEqual([])
    expect(document.body.textContent).toContain('项目与集合')
    expect($$('[data-testid=project-card]')).toHaveLength(2)
  })

  it('list_projects 返回空对象不崩,落到空状态', async () => {
    backend({ list_projects: {}, list_collections: {} })
    await open()
    expect(errors).toEqual([])
    expect($('[data-testid=projects-empty]')).not.toBeNull()
    expect(text()).toContain('还没有集合')
  })
})

describe('Projects · 四种状态', () => {
  it('读取时先显示骨架屏', async () => {
    const pending = deferred<unknown>()
    backend({ list_projects: () => pending.promise, list_collections: () => pending.promise })
    await open()
    expect($$('[data-testid=admin-loading]')).toHaveLength(2)
    pending.resolve({ projects: PROJECTS, collections: COLLECTIONS })
    await flushPromises()
    expect($$('[data-testid=admin-loading]')).toHaveLength(0)
  })

  it('项目读不到:只有项目这一块报错并给重试,集合和服务器来源照常显示;重试后恢复', async () => {
    backend({ list_projects: new CapabilityError('internal: 元数据库正忙', 'internal', 500) })
    await open()
    const section = $('[data-testid=projects-section]')!
    expect(section.querySelector('[data-testid=admin-error]')!.textContent).toContain('读取项目失败:元数据库正忙')
    expect($$('[data-testid=project-card]')).toHaveLength(0)
    // 页面别的部分不受影响
    expect($$('[data-testid=collection-card], [data-testid=rt-row]').length).toBeGreaterThan(0)
    expect($('[data-testid=server-sources]')).not.toBeNull()
    expect($('[data-testid=collections-section] [data-testid=admin-error]')).toBeNull()

    backend()
    button(section, '重试').click()
    await flushPromises()
    expect($$('[data-testid=project-card]')).toHaveLength(2)
    expect(section.querySelector('[data-testid=admin-error]')).toBeNull()
  })

  it('集合读不到:只有集合这一块报错并给重试,项目照常显示', async () => {
    backend({ list_collections: new CapabilityError('internal: 向量库未就绪', 'internal', 500) })
    await open()
    const section = $('[data-testid=collections-section]')!
    expect(section.querySelector('[data-testid=admin-error]')!.textContent).toContain('读取集合失败:向量库未就绪')
    expect($$('[data-testid=project-card]')).toHaveLength(2)
    backend()
    button(section, '重试').click()
    await flushPromises()
    expect(section.querySelector('[data-testid=admin-error]')).toBeNull()
    expect($('[data-testid=collections-summary]')!.textContent).toContain('4 个集合')
  })

  it('服务端 403:无权限,不给重试', async () => {
    backend({ list_projects: new CapabilityError('你的账号没有开通这个功能', 'forbidden', 403) })
    await open()
    expect($('[data-testid=projects-section] [data-testid=admin-forbidden]')).not.toBeNull()
    expect($('[data-testid=projects-section]')!.textContent).not.toContain('重试')
  })

  it('账号没有「本机目录」功能:整页说明未开通,不请求任何接口(包括服务器来源)', async () => {
    await open({ features: ['docs.notes'] })
    expect($('[data-testid=admin-forbidden]')).not.toBeNull()
    expect(callCapability).not.toHaveBeenCalled()
    expect($('[data-testid=server-sources]')).toBeNull()
    expect($('[data-testid=project-add]')).toBeNull()
  })

  it('没有项目:空状态说明 + 「添加项目」打开添加卡片', async () => {
    backend({ list_projects: { projects: [] } })
    await open()
    const empty = $('[data-testid=projects-empty]')!
    expect(empty.textContent).toContain('还没有项目')
    button(empty, '添加项目').click()
    await flushPromises()
    expect($('[data-testid=project-add-card]')).not.toBeNull()
  })

  it('没有集合:空状态,「去导入」跳到导入页', async () => {
    backend({ list_collections: { collections: [] } })
    await open()
    const empty = $('[data-testid=collections-section]')!
    expect(empty.textContent).toContain('还没有集合')
    button(empty, '去导入').click()
    expect(push).toHaveBeenCalledWith('/import')
  })
})

describe('Projects · 刷新页面时会话稍后才取回来', () => {
  it('先按「有权限」读取,会话取回来发现没有「本机目录」功能:整页切成未开通,服务器来源也收起,停掉轮询', async () => {
    await open()
    expect($$('[data-testid=project-card]')).toHaveLength(2)
    const session = useSessionStore()
    session.features = new Set(['docs.notes'])
    session.loaded = true
    await flushPromises()
    expect($('[data-testid=admin-forbidden]')).not.toBeNull()
    expect($$('[data-testid=project-card]')).toHaveLength(0)
    expect($('[data-testid=server-sources]')).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('一开始没有功能,管理员稍后开通:自动开始读取', async () => {
    await open({ features: ['docs.notes'] })
    expect(callCapability).not.toHaveBeenCalled()
    useSessionStore().features = new Set(['sources.local'])
    await flushPromises()
    expect($$('[data-testid=project-card]')).toHaveLength(2)
  })
})

describe('Projects · 项目卡片', () => {
  it('卡片:名字、目录、规则(没有规则写明意思)、上次索引;用中文术语', async () => {
    await open()
    const kb = card('knowledgeBase')
    expect(kb.textContent).toContain('/srv/workspace/knowledgeBase')
    expect(kb.textContent).toContain('src/**  docs/**')
    expect(kb.textContent).toContain('上次索引 12 分钟前')
    const ck = card('SampleApp')
    expect(ck.textContent).toContain('全部文件')
    expect(ck.textContent).toContain('还没有索引过')
    expect(text()).not.toMatch(/云端 LLM|\bcollection\b|\bhooks?\b|物理表|嵌入器|dry-run/)
    expect($('[data-testid=projects-summary]')!.textContent).toBe('2 个项目 · 4 个集合 · 当前索引模型 bge-m3-int8')
    expect($('[data-testid=projects-lead]')!.textContent).toContain('include')
  })

  it('开关有中文名、帮助文字(键名在里面)和可访问名称', async () => {
    await open()
    const rows = [...card('knowledgeBase').querySelectorAll('[data-testid^=switch-]')]
    expect(rows.map((row) => row.querySelector('.kb-pj-sw-text span')!.textContent)).toEqual(['提交后自动索引', '允许发给云端模型', '自动提炼'])
    expect(rows[1]!.textContent).toContain('allow_cloud_llm')
    expect(rows[2]!.textContent).toContain('extract_enabled')
    expect(rows.map((row) => row.querySelector('[role=switch]')!.getAttribute('aria-label'))).toEqual(['提交后自动索引', '允许发给云端模型', '自动提炼'])
    expect(rows.map((row) => row.querySelector('[role=switch]')!.getAttribute('aria-checked'))).toEqual(['true', 'true', 'true'])
  })

  it('开启提交后自动索引:先确认并说清后果,确认后才发请求', async () => {
    await open()
    ;(card('SampleApp').querySelector('[data-testid=switch-hooks] [role=switch]') as HTMLElement).click()
    await flushPromises()
    const options = ask.mock.calls[0]![0] as ConfirmOptions
    expect(options.title).toBe('开启「SampleApp」提交后自动索引?')
    expect(options.message).toContain('钩子')
    expect(options.tone).toBe('default')
    // 确认文案要说全:四个钩子名、原钩子备份为 .kb-orig 并链式调用、不调用大模型、首次触发全量扫描
    for (const name of ['post-commit', 'post-merge', 'post-checkout', 'post-rewrite']) expect(options.message).toContain(name)
    expect(options.message).toContain('.kb-orig')
    expect(options.message).toContain('链式调用')
    expect(options.message).toContain('不调用大模型')
    expect(options.message).toContain('全量扫描')
    expect(calls('install_hooks')[0]![1]).toEqual({ project: 'SampleApp' })
    expect(toasts[0]).toMatchObject({ message: '已开启提交后自动索引', tone: 'success' })
  })

  it('仓库的 hooks 目录由别的工具托管(managed_by_other):弹警告、不弹「已开启」,开关保持关', async () => {
    backend({ install_hooks: { hooks_dir: '/srv/sampleapp/.husky', managed_by_other: true, hooks: [] } })
    await open()
    ;(card('SampleApp').querySelector('[data-testid=switch-hooks] [role=switch]') as HTMLElement).click()
    await flushPromises()
    expect(calls('install_hooks')).toHaveLength(1)
    // 警告类提示,说明 kb 没有改动 hooks 目录、该怎么办
    expect(toasts[0]!.tone).toBe('warning')
    expect(toasts[0]!.message).toContain('core.hooksPath')
    expect(toasts[0]!.message).toContain('kb 没有改动')
    expect(toasts[0]!.message).toContain('手动加一行通知命令')
    // 不能出现成功提示
    expect(toastTexts().some((message) => message.includes('已开启'))).toBe(false)
    expect(toasts.some((entry) => entry.tone === 'success')).toBe(false)
    // 装完会重新读项目列表;后端没装上,开关仍然是关
    expect(calls('list_projects').length).toBeGreaterThan(1)
    expect(card('SampleApp').querySelector('[data-testid=switch-hooks] [role=switch]')!.getAttribute('aria-checked')).toBe('false')
    expect($('[data-testid=project-error]')).toBeNull()
  })

  it('开启时后端报错(例如不是 git 仓库):顶部说原因,不弹成功提示', async () => {
    backend({ install_hooks: new CapabilityError('invalid input: /srv/sampleapp 不是 git 仓库', 'invalid_input', 400) })
    await open()
    ;(card('SampleApp').querySelector('[data-testid=switch-hooks] [role=switch]') as HTMLElement).click()
    await flushPromises()
    expect($('[data-testid=project-error]')!.textContent).toContain('修改提交后自动索引失败')
    expect(toasts).toHaveLength(0)
  })

  it('非 git 目录:提交后自动索引置灰并有可见说明,点击没有反应(不弹确认、不发请求)', async () => {
    backend({ list_projects: { projects: [project('knowledgeBase'), project('Plain', { is_git: false, hooks_installed: false })] } })
    await open()
    const row = card('Plain').querySelector('[data-testid=switch-hooks]')!
    const toggle = row.querySelector('[role=switch]') as HTMLElement
    expect(toggle.getAttribute('aria-disabled')).toBe('true')
    expect(toggle.classList.contains('is-disabled')).toBe(true)
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    // 说明就在开关下面,读屏通过 aria-describedby 也能读到
    const note = row.querySelector('[data-testid=switch-note]') as HTMLElement
    expect(note.textContent).toBe('这个目录不是 git 仓库,没有可装的提交钩子。')
    expect(toggle.getAttribute('aria-describedby')).toBe(note.id)
    toggle.click()
    await flushPromises()
    expect(ask).not.toHaveBeenCalled()
    expect(calls('install_hooks')).toHaveLength(0)
    expect(toasts).toHaveLength(0)
    // 另外两个开关不受影响;git 项目的开关可用、没有说明
    expect(card('Plain').querySelector('[data-testid=switch-cloud] [role=switch]')!.getAttribute('aria-disabled')).not.toBe('true')
    const gitRow = card('knowledgeBase').querySelector('[data-testid=switch-hooks]')!
    expect(gitRow.querySelector('[role=switch]')!.getAttribute('aria-disabled')).not.toBe('true')
    expect(gitRow.querySelector('[data-testid=switch-note]')).toBeNull()
  })

  it('关闭提交后自动索引:红色确认;点取消什么也不发', async () => {
    answer(false)
    await open()
    ;(card('knowledgeBase').querySelector('[data-testid=switch-hooks] [role=switch]') as HTMLElement).click()
    await flushPromises()
    expect((ask.mock.calls[0]![0] as ConfirmOptions).tone).toBe('danger')
    expect(calls('install_hooks')).toHaveLength(0)
    expect(calls('uninstall_hooks')).toHaveLength(0)

    answer(true)
    ;(card('knowledgeBase').querySelector('[data-testid=switch-hooks] [role=switch]') as HTMLElement).click()
    await flushPromises()
    expect(calls('uninstall_hooks')[0]![1]).toEqual({ project: 'knowledgeBase' })
    expect(toasts[0]).toMatchObject({ message: '已关闭提交后自动索引', tone: 'success' })
  })

  it('云端模型 / 自动提炼开关:直接保存其它值不变,不重建索引', async () => {
    await open()
    ;(card('knowledgeBase').querySelector('[data-testid=switch-cloud] [role=switch]') as HTMLElement).click()
    await flushPromises()
    expect(calls('update_project')[0]![1]).toEqual({
      project: 'knowledgeBase',
      include: ['src/**', 'docs/**'],
      exclude: ['target/**'],
      allow_cloud_llm: false,
      extract_enabled: true,
      reindex: false,
    })
    ;(card('knowledgeBase').querySelector('[data-testid=switch-extract] [role=switch]') as HTMLElement).click()
    await flushPromises()
    expect(calls('update_project')[1]![1]).toMatchObject({ allow_cloud_llm: true, extract_enabled: false, reindex: false })
  })

  it('保存失败:顶上说明发生了什么和怎么办,可以关掉', async () => {
    backend({ update_project: new CapabilityError('invalid input: 项目正在重建索引', 'invalid_input', 400) })
    await open()
    ;(card('knowledgeBase').querySelector('[data-testid=switch-cloud] [role=switch]') as HTMLElement).click()
    await flushPromises()
    const alert = $('[data-testid=project-error]')!
    expect(alert.getAttribute('role')).toBe('alert')
    expect(alert.textContent).toContain('保存设置失败:项目正在重建索引')
    expect(alert.textContent).not.toContain('invalid input')
    ;(alert.querySelector('[data-testid=project-error-close]') as HTMLElement).click()
    await flushPromises()
    expect($('[data-testid=project-error]')).toBeNull()
  })

  it('操作之后重新读取失败:旧卡片留着,顶上说明,不把整块换成报错', async () => {
    await open()
    backend({ list_projects: new CapabilityError('internal: 元数据库正忙', 'internal', 500) })
    ;(card('knowledgeBase').querySelector('[data-testid=switch-cloud] [role=switch]') as HTMLElement).click()
    await flushPromises()
    expect($$('[data-testid=project-card]')).toHaveLength(2)
    expect($('[data-testid=projects-section] [data-testid=admin-error]')).toBeNull()
    expect($('[data-testid=project-error]')!.textContent).toContain('读取项目失败:元数据库正忙')
  })

  it('增量索引 / 全量重建:发对应模式的请求,提示里说去哪看进度', async () => {
    await open()
    ;(card('knowledgeBase').querySelector('[data-testid=project-reindex]') as HTMLElement).click()
    await flushPromises()
    expect(calls('reindex_project')[0]![1]).toEqual({ project: 'knowledgeBase', mode: 'incremental' })
    ;(card('knowledgeBase').querySelector('[data-testid=project-rebuild]') as HTMLElement).click()
    await flushPromises()
    expect(calls('reindex_project')[1]![1]).toEqual({ project: 'knowledgeBase', mode: 'full' })
    expect(latestToast()).toBe('knowledgeBase:全量重建已入队,进度在「任务」页')
  })

  it('投递索引失败:顶上说原因', async () => {
    backend({ reindex_project: new CapabilityError('forbidden: 你的账号没有开通这个功能', 'forbidden', 403) })
    await open()
    ;(card('knowledgeBase').querySelector('[data-testid=project-reindex]') as HTMLElement).click()
    await flushPromises()
    expect($('[data-testid=project-error]')!.textContent).toContain('没有开通这个功能')
  })

  it('编辑:规则用逗号(中英文)或换行分隔,保存时带上是否重建索引', async () => {
    await open()
    ;(card('knowledgeBase').querySelector('[data-testid=project-edit]') as HTMLElement).click()
    await flushPromises()
    const inputs = $$('input.kb-input, .kb-input input, input').filter((input) => input.getAttribute('type') !== 'checkbox')
    expect(inputs.length).toBeGreaterThanOrEqual(2)
    ;(inputs[0] as HTMLInputElement).value = 'src/**，lib/**'
    inputs[0]!.dispatchEvent(new Event('input'))
    ;(inputs[1] as HTMLInputElement).value = 'target/**, *.min.js'
    inputs[1]!.dispatchEvent(new Event('input'))
    await flushPromises()
    ;($('[data-testid=project-save]') as HTMLElement).click()
    await flushPromises()
    expect(calls('update_project')[0]![1]).toMatchObject({ project: 'knowledgeBase', include: ['src/**', 'lib/**'], exclude: ['target/**', '*.min.js'], reindex: true })
    expect($('[data-testid=project-save]')).toBeNull()
  })

  it('移除项目:红色确认,写清后果;确认后调用 remove_project,取消则不调用', async () => {
    answer(false)
    await open()
    ;(card('SampleApp').querySelector('[data-testid=project-remove]') as HTMLElement).click()
    await flushPromises()
    const options = ask.mock.calls[0]![0] as ConfirmOptions
    expect(options.title).toBe('移除项目「SampleApp」?')
    expect(options.tone).toBe('danger')
    expect(options.message).toContain('不能恢复')
    expect(options.message).toContain('集合')
    expect(options.message).toContain('目录里的文件不受影响')
    expect(calls('remove_project')).toHaveLength(0)

    answer(true)
    ;(card('SampleApp').querySelector('[data-testid=project-remove]') as HTMLElement).click()
    await flushPromises()
    expect(calls('remove_project')[0]![1]).toEqual({ project: 'SampleApp' })
    // 项目和集合都重新读
    expect(calls('list_projects').length).toBeGreaterThanOrEqual(2)
    expect(calls('list_collections').length).toBeGreaterThanOrEqual(2)
  })

  it('添加项目:没填目录时按钮不可点;填了就发请求、收起卡片、重新读取', async () => {
    await open()
    ;($('[data-testid=project-add]') as HTMLElement).click()
    await flushPromises()
    const go = $<HTMLButtonElement>('[data-testid=project-add-go]')!
    expect(go.disabled).toBe(true)
    const inputs = $$('[data-testid=project-add-card] input')
    ;(inputs[0] as HTMLInputElement).value = ' /srv/workspace/new-proj '
    inputs[0]!.dispatchEvent(new Event('input'))
    await flushPromises()
    expect(go.disabled).toBe(false)
    go.click()
    await flushPromises()
    expect(calls('add_project')[0]![1]).toEqual({ path: '/srv/workspace/new-proj', name: undefined })
    expect($('[data-testid=project-add-card]')).toBeNull()
    expect(toastTexts()).toContain('项目已添加,索引任务已入队')
  })

  it('添加失败:卡片留着(填的内容不丢),顶上说原因', async () => {
    backend({ add_project: new CapabilityError('invalid input: 目录不存在', 'invalid_input', 400) })
    await open()
    ;($('[data-testid=project-add]') as HTMLElement).click()
    await flushPromises()
    const input = $<HTMLInputElement>('[data-testid=project-add-card] input')!
    input.value = '/nope'
    input.dispatchEvent(new Event('input'))
    await flushPromises()
    $<HTMLButtonElement>('[data-testid=project-add-go]')!.click()
    await flushPromises()
    expect($('[data-testid=project-error]')!.textContent).toContain('添加项目失败:目录不存在')
    expect($('[data-testid=project-add-card]')).not.toBeNull()
    expect($<HTMLInputElement>('[data-testid=project-add-card] input')!.value).toBe('/nope')
  })

  it('AI 关闭:卡片和编辑对话框里都没有云端模型 / 自动提炼,页面任何位置没有「AI」字样', async () => {
    await open({ ai: false })
    expect($$('[data-testid=switch-cloud], [data-testid=switch-extract]')).toHaveLength(0)
    expect($$('[data-testid=switch-hooks]')).toHaveLength(2)
    ;(card('knowledgeBase').querySelector('[data-testid=project-edit]') as HTMLElement).click()
    await flushPromises()
    expect(text()).not.toMatch(/AI|云端|提炼/)
    expect($('[data-testid=project-save]')).not.toBeNull()
  })

  it('AI 关闭时保存编辑,云端 / 提炼两个值照原样提交,不被悄悄改掉', async () => {
    await open({ ai: false })
    ;(card('knowledgeBase').querySelector('[data-testid=project-edit]') as HTMLElement).click()
    await flushPromises()
    ;($('[data-testid=project-save]') as HTMLElement).click()
    await flushPromises()
    expect(calls('update_project')[0]![1]).toMatchObject({ allow_cloud_llm: true, extract_enabled: true })
  })
})

describe('Projects · 集合表', () => {
  it('桌面:表格列用中文,类型 / 索引模型 / 内容片段 / 状态,笔记集合叫「笔记」不叫经验', async () => {
    await open()
    const headers = $$('[data-testid=collections-section] th').map((item) => item.textContent!.trim())
    expect(headers).toEqual(['集合', '类型', '索引模型', '内容片段', '存储表', '状态', '操作'])
    const rows = $$('[data-testid=collections-section] [data-testid=rt-row]')
    expect(rows).toHaveLength(4)
    expect(rows[0]!.textContent).toContain('knowledgeBase/code')
    expect(rows[0]!.textContent).toContain('代码')
    expect(rows[0]!.textContent).toContain('bge-m3-int8 · 1024 维')
    expect(rows[0]!.textContent).toContain('3,112')
    expect(rows[1]!.textContent).toContain('笔记')
    expect(rows[3]!.textContent).toContain('外部')
    expect($('[data-testid=collections-summary]')!.textContent).toBe('4 个集合 · 共 9,006 个内容片段')
    expect(text()).not.toMatch(/经验|维度|物理表/)
  })

  it('更换中的集合:状态写进度和换成哪个模型,不能再点更换,但还能删除', async () => {
    await open()
    // 只要还在跑 / 排队的迁移任务,不整份拉历史任务
    expect(calls('job_list')[0]![1]).toEqual({ states: ['running', 'queued'], kinds: ['migrate'], page_size: 200 })
    const row = $$('[data-testid=collections-section] [data-testid=rt-row]')[2]!
    expect(row.textContent).toContain('更换中 41%')
    expect(row.textContent).toContain('换成 bge-m3-q8')
    expect((row.querySelector('[data-testid=collection-migrate]') as HTMLButtonElement).disabled).toBe(true)
    expect((row.querySelector('[data-testid=collection-delete]') as HTMLButtonElement).disabled).toBe(false)
    // 不再有单独的「迁移计划」行重复这条信息
    expect(text()).not.toContain('迁移计划')
  })

  it('手机:集合变成卡片,每张有名字、类型、状态、一行模型和片段数、整行的操作按钮', async () => {
    await open({ phone: true })
    expect($$('[data-testid=collections-section] [data-testid=rt-row]')).toHaveLength(0)
    const cards = $$('[data-testid=collection-card]')
    expect(cards).toHaveLength(4)
    expect(cards[0]!.textContent).toContain('knowledgeBase/code')
    expect(cards[0]!.textContent).toContain('代码')
    expect(cards[0]!.textContent).toContain('就绪')
    expect(cards[0]!.textContent).toContain('bge-m3-int8 · 1024 维 · 3,112 个内容片段')
    expect(cards[0]!.textContent).toContain('更换索引模型')
    expect(cards[0]!.textContent).toContain('删除')
    // 更换中的卡片有进度条
    expect(cards[2]!.textContent).toContain('更换中 41%')
    expect(cards[2]!.querySelector('[role=progressbar]')!.getAttribute('aria-valuenow')).toBe('41')
    expect(cards[0]!.querySelector('[role=progressbar]')).toBeNull()
  })

  it('删除集合:红色确认,写清「全部内容含笔记、不能恢复」;取消则不删', async () => {
    answer(false)
    await open()
    ;($$('[data-testid=collections-section] [data-testid=collection-delete]')[1] as HTMLElement).click()
    await flushPromises()
    const options = ask.mock.calls[0]![0] as ConfirmOptions
    expect(options.title).toBe('删除集合「knowledgeBase/insights」?')
    expect(options.tone).toBe('danger')
    expect(options.message).toContain('不能恢复')
    expect(options.message).toContain('笔记')
    expect(options.message).toContain('482')
    expect(calls('delete_collection')).toHaveLength(0)

    answer(true)
    ;($$('[data-testid=collections-section] [data-testid=collection-delete]')[0] as HTMLElement).click()
    await flushPromises()
    expect(calls('delete_collection')[0]![1]).toEqual({ collection: 'knowledgeBase/code' })
  })

  it('删除失败时错误显示在确认框里(真实 useConfirm 的行为),列表不变', async () => {
    backend({ delete_collection: new CapabilityError('internal: 向量表被占用', 'internal', 500) })
    ask.mockImplementation(async (options: ConfirmOptions) => {
      try {
        await options.action?.()
        return true
      } catch {
        return false
      }
    })
    await open()
    const before = calls('list_collections').length
    ;($$('[data-testid=collections-section] [data-testid=collection-delete]')[0] as HTMLElement).click()
    await flushPromises()
    expect($$('[data-testid=collections-section] [data-testid=rt-row]')).toHaveLength(4)
    expect(calls('list_collections')).toHaveLength(before)
  })
})

describe('Projects · 更换索引模型', () => {
  const dialog = () => $('[role=dialog]')!
  async function openMigrate(index = 0) {
    ;($$('[data-testid=collections-section] [data-testid=collection-migrate]')[index] as HTMLElement).click()
    await flushPromises()
  }
  const pick = async (name: string) => {
    wrapper!.findAllComponents({ name: 'KbSelect' }).at(-1)!.vm.$emit('update:modelValue', name)
    await flushPromises()
  }

  it('打开后默认选第一个和当前不同的模型并立刻估算,结果用中文写出来', async () => {
    await open()
    await openMigrate(0)
    expect(dialog().textContent).toContain('更换索引模型 · knowledgeBase/code')
    expect(dialog().textContent).toContain('旧索引会保留,可以回滚')
    expect(dialog().textContent).toContain('现在用的是 bge-m3-int8')
    expect(calls('migrate_plan')[0]![1]).toEqual({ collection: 'knowledgeBase/code', to: 'bge-m3' })
    const plan = $('[data-testid=migrate-plan]')!.textContent!.replace(/\s+/g, ' ')
    expect(plan).toContain('需要')
    expect(plan).toContain('5,100 个片段(其中笔记 390 条)')
    expect(plan).toContain('约 1 分 36 秒')
    expect(plan).not.toMatch(/insight|嵌入|dry-run|兼容组/)
    expect($<HTMLButtonElement>('[data-testid=migrate-go]')!.disabled).toBe(false)
  })

  it('新旧模型兼容:说不需要重新索引', async () => {
    backend({ migrate_plan: { ...PLAN, can_switch_without_reembed: true } })
    await open()
    await openMigrate(0)
    const plan = $('[data-testid=migrate-plan]')!.textContent!
    expect(plan).toContain('不需要,切换很快')
    expect(plan).not.toContain('预计耗时')
  })

  it('选和当前相同的模型:提示不需要更换,不估算,确认按钮灰着', async () => {
    await open()
    await openMigrate(0)
    const before = calls('migrate_plan').length
    await pick('bge-m3-int8')
    expect($('[data-testid=migrate-same]')!.textContent).toContain('不需要更换')
    expect(calls('migrate_plan')).toHaveLength(before)
    expect($('[data-testid=migrate-plan]')).toBeNull()
    expect($<HTMLButtonElement>('[data-testid=migrate-go]')!.disabled).toBe(true)
  })

  it('估算中确认按钮灰着;连续切换模型时,晚到的旧结果不能盖掉新结果', async () => {
    const first = deferred<unknown>()
    const second = deferred<unknown>()
    let n = 0
    backend({ migrate_plan: () => (++n === 1 ? first.promise : second.promise) })
    await open()
    await openMigrate(0)
    expect($('[data-testid=migrate-loading]')).not.toBeNull()
    expect($<HTMLButtonElement>('[data-testid=migrate-go]')!.disabled).toBe(true)
    await pick('multilingual-minilm')
    second.resolve({ ...PLAN, to_embedder: 'fastembed:multilingual-minilm', rows: 111 })
    await flushPromises()
    first.resolve({ ...PLAN, to_embedder: 'fastembed:bge-m3', rows: 999 })
    await flushPromises()
    const plan = $('[data-testid=migrate-plan]')!.textContent!
    expect(plan).toContain('111 个片段')
    expect(plan).not.toContain('999')
  })

  it('估算失败:就地说原因并给「重新估算」,不会一直转圈;确认按钮灰着', async () => {
    backend({ migrate_plan: new CapabilityError('invalid input: 目标嵌入器没有安装', 'invalid_input', 400) })
    await open()
    await openMigrate(0)
    const fail = $('[data-testid=migrate-plan-error]')!
    expect(fail.textContent).toContain('估算失败:目标嵌入器没有安装')
    expect($('[data-testid=migrate-loading]')).toBeNull()
    expect($<HTMLButtonElement>('[data-testid=migrate-go]')!.disabled).toBe(true)
    backend()
    ;($('[data-testid=migrate-retry]') as HTMLElement).click()
    await flushPromises()
    expect($('[data-testid=migrate-plan-error]')).toBeNull()
    expect($('[data-testid=migrate-plan]')).not.toBeNull()
  })

  it('确认更换:发 migrate_model,提示说去哪看进度,关掉对话框并重新读集合', async () => {
    await open()
    await openMigrate(0)
    const before = calls('list_collections').length
    $<HTMLButtonElement>('[data-testid=migrate-go]')!.click()
    await flushPromises()
    expect(calls('migrate_model')[0]![1]).toEqual({ collection: 'knowledgeBase/code', to: 'bge-m3' })
    expect(latestToast()).toBe('已开始更换「knowledgeBase/code」的索引模型,进度在「任务」页(任务编号 j_migrate)')
    expect($('[role=dialog]')).toBeNull()
    expect(calls('list_collections')).toHaveLength(before + 1)
  })

  it('提交失败:对话框不关,错误显示在里面,可以再点', async () => {
    backend({ migrate_model: new CapabilityError('conflict: 这个集合正在更换', 'conflict', 409) })
    await open()
    await openMigrate(0)
    $<HTMLButtonElement>('[data-testid=migrate-go]')!.click()
    await flushPromises()
    expect($('[data-testid=migrate-error]')!.textContent).toContain('更换索引模型失败')
    expect($('[role=dialog]')).not.toBeNull()
    expect($<HTMLButtonElement>('[data-testid=migrate-go]')!.disabled).toBe(false)
  })

  it('取消:关掉对话框,不提交', async () => {
    await open()
    await openMigrate(0)
    button(dialog(), '取消').click()
    await flushPromises()
    expect($('[role=dialog]')).toBeNull()
    expect(calls('migrate_model')).toHaveLength(0)
  })
})

describe('Projects · 更换进度自动刷新', () => {
  it('有集合在更换时每 10 秒重新读一次集合,让进度动起来', async () => {
    await open()
    // 页面之外,服务器来源那块(useSources)也会读一次集合清单,所以只比较增量
    const base = calls('list_collections').length
    vi.advanceTimersByTime(10_000)
    await flushPromises()
    expect(calls('list_collections')).toHaveLength(base + 1)
    // 完成后状态变回「就绪」,不再轮询
    backend({ list_collections: { collections: COLLECTIONS.map((item) => ({ ...item, migrating_to: null })) }, job_list: { jobs: [] } })
    vi.advanceTimersByTime(10_000)
    await flushPromises()
    expect(calls('list_collections')).toHaveLength(base + 2)
    expect($$('[data-testid=collections-section] [data-testid=rt-row]')[2]!.textContent).toContain('就绪')
    vi.advanceTimersByTime(30_000)
    await flushPromises()
    expect(calls('list_collections')).toHaveLength(base + 2)
  })

  it('没有集合在更换就不轮询;卸载后定时器收掉', async () => {
    backend({ list_collections: { collections: [coll('a/code')] }, job_list: { jobs: [] } })
    await open()
    const base = calls('list_collections').length
    vi.advanceTimersByTime(30_000)
    await flushPromises()
    expect(calls('list_collections')).toHaveLength(base)
    wrapper!.unmount()
    wrapper = null
    expect(vi.getTimerCount()).toBe(0)
  })

  it('页面在后台时不轮询', async () => {
    await open()
    const base = calls('list_collections').length
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    try {
      vi.advanceTimersByTime(10_000)
      await flushPromises()
      expect(calls('list_collections')).toHaveLength(base)
    } finally {
      Reflect.deleteProperty(document, 'visibilityState')
    }
  })
})
