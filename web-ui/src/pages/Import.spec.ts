// 导入页(数据源 + 解析队列合并后):页签与地址、来源归属、拖入区(手机)、粘贴网址、指标卡、添加数据只给用户级类型。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { reactive } from 'vue'
import { PHONE_QUERY } from '@kb-ui/index'

const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  callCapability: (...args: unknown[]) => callCapability(...args),
}))
const replace = vi.fn(async (to: { query?: Record<string, string> }) => {
  route.query = to.query ?? {}
})
const push = vi.fn()
const route = reactive<{ path: string; query: Record<string, string> }>({ path: '/import', query: {} })
vi.mock('vue-router', () => ({
  useRoute: () => route,
  useRouter: () => ({ replace, push }),
  RouterLink: { props: ['to'], template: '<a class="router-link" :data-to="typeof to === \'string\' ? to : JSON.stringify(to)"><slot /></a>' },
}))
vi.mock('@/layouts/AppShell.vue', () => ({ default: { template: '<div class="app-shell"><slot /></div>' } }))
vi.mock('@/composables/useLiveEvents', () => ({ useLiveEvents: () => () => undefined, subscribeLive: () => () => undefined }))
const requestUpload = vi.fn()
vi.mock('@/api/upload', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/api/upload')>()), requestUpload: (...args: unknown[]) => requestUpload(...args) }))

import { useSessionStore } from '@/stores/session'
import Import from './Import.vue'

const source = (id: string, kind: string, extra: Record<string, unknown> = {}) => ({ id, kind, name: `来源 ${id}`, uri: kind === 'local_dir' ? '/data/docs' : `https://${id}.example.com/`, collection: 'c', tags: [], include: [], exclude: [], depth: 1, allow_hosts: [], refresh_minutes: null, status: 'idle', last_synced_at: 1, last_error: null, files: 10, created_at: 1, ...extra })
const SOURCES = [source('web1', 'web'), source('up1', 'upload'), source('note1', 'note'), source('dir1', 'local_dir'), source('git1', 'git')]
const file = (id: string, state: string, extra: Record<string, unknown> = {}) => ({ id, batch_id: 'bat_12345678', source_id: 'web1', collection: 'c', rel_path: `docs/${id}.pdf`, size: 2048, state, error: state === 'failed' ? '解析超时' : null, chunks: 5, vectors: 5, elapsed_ms: 800, ...extra })
const FILES = [file('f1', 'done'), file('f2', 'failed'), file('f3', 'embedding'), file('f4', 'quarantined')]

let replies: Record<string, unknown> = {}
function backend(overrides: Record<string, unknown> = {}) {
  replies = {
    list_sources: { sources: SOURCES, items: SOURCES.map((item) => ({ source: item, stats: null })) },
    list_collections: { collections: [{ name: 'proj/docs' }] },
    list_ingest: { files: FILES, total: 4 },
    get_batch_progress: { batch: 'bat_12345678', collection: 'c', state: 'running', stage: 'embed', done: 1, total: 4, chunks: 0, vectors: 0, throughput_cps: 1, eta_s: 30, elapsed_s: 10, current_files: [], backend: 'x', stages: [] },
    get_config: { upload: { max_file_mb: 2048 } },
    system_status: { components: [] },
    ...overrides,
  }
  callCapability.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
    if (name === 'list_ingest' && args?.page_size === 1) return { total: 4, files: [] }
    const reply = replies[name]
    if (reply instanceof Error) throw reply
    return reply ?? {}
  })
}
const $ = <T extends Element = HTMLElement>(selector: string) => document.body.querySelector<T>(selector)
const $$ = (selector: string) => [...document.body.querySelectorAll<HTMLElement>(selector)]
const calls = (name: string) => callCapability.mock.calls.filter((call) => call[0] === name)

function setViewport(phone: boolean) {
  window.matchMedia = ((query: string) => ({ matches: phone && query === PHONE_QUERY, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia
}
let wrapper: VueWrapper | null = null
async function open(options: { phone?: boolean; features?: string[]; query?: Record<string, string>; path?: string } = {}) {
  setViewport(options.phone ?? false)
  route.path = options.path ?? '/import'
  route.query = options.query ?? {}
  const session = useSessionStore()
  session.features = new Set(options.features ?? ['docs.upload'])
  session.loaded = true
  wrapper = mount(Import, { attachTo: document.body })
  await flushPromises()
  await flushPromises()
}

beforeEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  callCapability.mockReset()
  replace.mockClear()
  push.mockClear()
  requestUpload.mockClear()
  setActivePinia(createPinia())
  backend()
})

describe('Import 导入页 · 合并', () => {
  it('一页里有:拖入区、粘贴网址、四个指标、导入记录和数据来源两个页签;默认在「导入记录」', async () => {
    await open()
    expect($('[data-testid=import-drop]')).not.toBeNull()
    expect($('[data-testid=import-web]')).not.toBeNull()
    expect($$('[data-testid=import-metrics] .metric')).toHaveLength(4)
    const pageTabs = $$('[role=tablist]')[0]!.querySelectorAll('[role=tab]')
    expect([...pageTabs].map((tab) => tab.textContent!.replace(/\s+/g, ' ').trim())).toEqual(['导入记录4', '数据来源3'])
    expect($('[data-testid=import-records]')).not.toBeNull()
    expect($('[data-testid=import-sources]')).toBeNull()
  })

  it('旧的队列地址 /import/queue 也进这一页,落在「导入记录」,批次和筛选参数照常生效', async () => {
    await open({ path: '/import/queue', query: { batch: 'all', filter: 'failed' } })
    expect($('[data-testid=import-records]')).not.toBeNull()
    const lists = calls('list_ingest').filter((call) => (call[1] as { page_size?: number }).page_size === 200)
    expect(lists[0]![1]).toEqual({ page_size: 200 }) // batch=all → 不带 batch_id
    expect($$('[data-testid=record-card], [data-testid=rt-row]').length).toBe(1) // 只留失败的
  })

  it('?tab=sources 进「数据来源」页签', async () => {
    await open({ query: { tab: 'sources' } })
    expect($('[data-testid=import-sources]')).not.toBeNull()
    expect($('[data-testid=import-records]')).toBeNull()
  })

  it('切页签只改地址里的 tab(其它参数保留),回到「导入记录」时去掉 tab', async () => {
    await open({ query: { batch: 'all' } })
    const pageTabs = () => $$('[role=tablist]')[0]!.querySelectorAll<HTMLElement>('[role=tab]')
    pageTabs()[1]!.click()
    await flushPromises()
    expect(replace).toHaveBeenLastCalledWith({ path: '/import', query: { batch: 'all', tab: 'sources' } })
    pageTabs()[0]!.click()
    await flushPromises()
    expect(replace).toHaveBeenLastCalledWith({ path: '/import', query: { batch: 'all' } })
  })
})

describe('Import 导入页 · 来源归属', () => {
  it('数据来源里只有自己的(网页 / 上传 / 笔记);服务器目录和 Git 不在这里', async () => {
    await open({ query: { tab: 'sources' } })
    const names = $$('[data-testid=rt-row] .kb-srct-title').map((el) => el.textContent!.trim())
    expect(names).toEqual(['来源 web1', '来源 up1', '来源 note1'])
    expect(document.body.textContent).not.toContain('/data/docs')
  })

  it('点一个来源看详情:有「同步」和「移除」(布尔 prop 没传时 Vue 会当成 false,按钮曾因此消失)', async () => {
    await open({ query: { tab: 'sources' } })
    $$('[data-testid=rt-row]')[0]!.click()
    await flushPromises()
    expect($('[data-testid=source-detail-sync]')).not.toBeNull()
    expect($('[data-testid=source-detail-remove]')).not.toBeNull()
  })

  it('有 sources.local 的账号会看到去「管理 → 项目与集合」的说明;没有的看不到', async () => {
    await open({ query: { tab: 'sources' }, features: ['docs.upload', 'sources.local'] })
    expect($('[data-testid=server-note]')!.textContent).toContain('项目与集合')
    expect($('[data-testid=server-note] a')!.getAttribute('data-to')).toBe('/admin/projects')
    wrapper!.unmount()
    document.body.innerHTML = ''
    await open({ query: { tab: 'sources' } })
    expect($('[data-testid=server-note]')).toBeNull()
  })

  it('「全部同步」只同步自己的来源,不碰服务器目录 / Git', async () => {
    await open()
    $<HTMLButtonElement>('[data-testid=import-sync-all]')!.click()
    await flushPromises()
    expect(calls('sync_source').map((call) => (call[1] as { id: string }).id)).toEqual(['web1', 'up1', 'note1'])
  })

  it('页面副标题的来源数只算自己的', async () => {
    await open()
    expect(document.body.textContent).toContain('3 个数据来源')
  })

  it('取不到来源:整块报错并给「重新加载」', async () => {
    backend({ list_sources: new Error('boom') })
    await open({ query: { tab: 'sources' } })
    expect($('[data-testid=sources-error]')!.textContent).toContain('没能读取数据来源')
    backend()
    $<HTMLButtonElement>('[data-testid=sources-error] button')!.click()
    await flushPromises()
    expect($('[data-testid=sources-error]')).toBeNull()
  })
})

describe('Import 导入页 · 添加数据', () => {
  it('「添加数据」只给网页 / 上传 / 压缩包 / 笔记,没有服务器目录和 Git', async () => {
    await open()
    $<HTMLButtonElement>('[data-testid=import-add]')!.click()
    await flushPromises()
    const types = $$('.kb-add-types .stype').map((el) => el.textContent!.replace(/\s+/g, ' ').trim())
    expect(types).toHaveLength(4)
    expect(types.join('|')).not.toMatch(/服务器目录|Git/)
    expect(types.join('|')).toMatch(/网页/)
    expect(types.join('|')).toMatch(/上传文件/)
  })

  it('粘贴网址:带着网址打开「添加数据」(选集合、抓取深度还要用户确认),不是静默提交', async () => {
    await open()
    const input = $<HTMLInputElement>('#import-web-url')!
    input.value = 'docs.example.com/guide'
    input.dispatchEvent(new Event('input'))
    await flushPromises()
    $<HTMLButtonElement>('[data-testid=import-web-go]')!.click()
    await flushPromises()
    expect(calls('add_source')).toHaveLength(0)
    expect($('.kb-add-types .stype.on')!.textContent).toContain('网页')
    expect(($('.kb-add-fields input') as HTMLInputElement).value).toBe('https://docs.example.com/guide')
  })

  it('不像网址的内容:提示怎么写,不打开对话框', async () => {
    await open()
    const input = $<HTMLInputElement>('#import-web-url')!
    input.value = 'hello world'
    input.dispatchEvent(new Event('input'))
    await flushPromises()
    $<HTMLButtonElement>('[data-testid=import-web-go]')!.click()
    await flushPromises()
    expect($('[data-testid=import-web-error]')!.textContent).toContain('不像一个网址')
    expect($('.kb-add-types')).toBeNull()
  })

  it('没填网址时「抓取」是灰的', async () => {
    await open()
    expect($<HTMLButtonElement>('[data-testid=import-web-go]')!.disabled).toBe(true)
  })
})

describe('Import 导入页 · 手机', () => {
  it('拖入区变成「选择要导入的文件」,没有「拖入」字样,也没有选择文件夹(手机浏览器不支持)', async () => {
    await open({ phone: true })
    const zone = $('[data-testid=import-drop]')!.textContent!
    expect(zone).toContain('选择要导入的文件')
    expect(zone).not.toContain('拖入')
    expect(zone).not.toContain('选择文件夹')
    wrapper!.unmount()
    document.body.innerHTML = ''
    await open({ phone: false })
    expect($('[data-testid=import-drop]')!.textContent).toContain('拖入文件或文件夹即可添加')
    expect($('[data-testid=import-drop]')!.textContent).toContain('选择文件夹')
  })

  it('导入记录在手机上是卡片', async () => {
    await open({ phone: true })
    expect($$('[data-testid=record-card]')).toHaveLength(4)
    expect($$('[data-testid=rt-row]')).toHaveLength(0)
  })

  it('数据来源在手机上也是卡片', async () => {
    await open({ phone: true, query: { tab: 'sources' } })
    expect($$('[data-testid=source-card]')).toHaveLength(3)
  })

  it('支持的格式在手机上默认折起来,电脑上展开', async () => {
    await open({ phone: true })
    expect($<HTMLDetailsElement>('.kb-imp-cover')!.open).toBe(false)
    wrapper!.unmount()
    document.body.innerHTML = ''
    await open({ phone: false })
    expect($<HTMLDetailsElement>('.kb-imp-cover')!.open).toBe(true)
  })
})

describe('Import 导入页 · 指标卡', () => {
  it('点「解析失败」直接看全部批次里失败的文件(改地址:batch=all & filter=failed,回到导入记录页签)', async () => {
    await open({ query: { tab: 'sources' } })
    $<HTMLButtonElement>('[data-testid=metric-failed]')!.click()
    await flushPromises()
    expect(replace).toHaveBeenLastCalledWith({ path: '/import', query: { batch: 'all', filter: 'failed' } })
  })

  it('点「待解析」「已隔离」各看各的', async () => {
    await open()
    $<HTMLButtonElement>('[data-testid=metric-pending]')!.click()
    await flushPromises()
    expect(replace).toHaveBeenLastCalledWith({ path: '/import', query: { batch: 'all', filter: 'active' } })
    $<HTMLButtonElement>('[data-testid=metric-quarantined]')!.click()
    await flushPromises()
    expect(replace).toHaveBeenLastCalledWith({ path: '/import', query: { batch: 'all', filter: 'quarantined' } })
  })
})

describe('Import 导入页 · 导入记录', () => {
  it('失败的文件有「重试」,隔离的有「释放」;重试失败 N 个按钮发批量重试', async () => {
    await open()
    expect(calls('list_ingest').some((call) => (call[1] as { batch_id?: string }).batch_id === 'bat_12345678')).toBe(true)
    $<HTMLButtonElement>('[data-testid=records-retry-failed]')!.click()
    await flushPromises()
    expect(calls('retry_ingest')[0]![1]).toEqual({ ids: ['f2'] })
  })

  it('读取导入记录失败:整块报错并给「重新加载」', async () => {
    backend({ list_ingest: new Error('boom') })
    await open()
    expect($('[data-testid=records-error]')!.textContent).toContain('没能读取导入记录')
  })
})

describe('Import 导入页 · 目标目录与子文件夹', () => {
  it('默认提供集合选择器与子文件夹输入框,并能从 query.collection 初始化', async () => {
    await open({ query: { collection: 'proj/docs' } })
    const select = $<HTMLSelectElement>('[data-testid=import-target-collection]')!
    expect(select).not.toBeNull()
    const folderInput = $<HTMLInputElement>('[data-testid=import-target-folder]')!
    expect(folderInput).not.toBeNull()
    expect(folderInput.value).toBe('')
    expect($('[data-testid=import-drop]')!.textContent).toContain('添加到 proj/docs')
  })

  it('设置目标目录与子文件夹后,点击选择文件会携带前缀与目标集合参数', async () => {
    await open({ query: { collection: 'proj/docs' } })
    const folderInput = $<HTMLInputElement>('[data-testid=import-target-folder]')!
    folderInput.value = '财务/月报'
    folderInput.dispatchEvent(new Event('input'))
    await flushPromises()
    expect($('[data-testid=import-drop]')!.textContent).toContain('添加到 proj/docs / 财务/月报')

    const fileInput = $<HTMLInputElement>('[data-testid=pick-file]')!
    const testFile = new File(['content'], 'report.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    Object.defineProperty(fileInput, 'files', { value: [testFile], configurable: true })
    fileInput.dispatchEvent(new Event('change'))
    await flushPromises()

    expect(requestUpload).toHaveBeenCalled()
    const [uploadedFiles, options] = requestUpload.mock.calls.at(-1)!
    expect(options).toEqual({ collection: 'proj/docs' })
    expect(uploadedFiles[0].webkitRelativePath).toBe('财务/月报/report.xlsx')
  })
})
