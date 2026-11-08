// 项目与集合页里的「服务器目录与 Git 来源」区块(从「导入」页移过来的):只列这两类、能同步 / 看详情 / 添加(只给这两类)。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  callCapability: (...args: unknown[]) => callCapability(...args),
}))
vi.mock('vue-router', () => ({ useRoute: () => ({ path: '/admin/projects', query: {} }), useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }))
vi.mock('@/layouts/AppShell.vue', () => ({ default: { template: '<div class="app-shell"><slot /></div>' } }))

import Projects from './Projects.vue'

const source = (id: string, kind: string) => ({ id, kind, name: `来源 ${id}`, uri: kind === 'git' ? 'git@example.com:team/repo.git' : kind === 'local_dir' ? '/data/docs' : `https://${id}.example.com/`, collection: 'c', tags: [], include: [], exclude: [], depth: 1, allow_hosts: [], refresh_minutes: null, status: 'idle', last_synced_at: 1, last_error: null, files: 5, created_at: 1 })
const SOURCES = [source('dir1', 'local_dir'), source('git1', 'git'), source('web1', 'web'), source('up1', 'upload')]

let replies: Record<string, unknown> = {}
function backend(overrides: Record<string, unknown> = {}) {
  replies = {
    list_sources: { sources: SOURCES, items: [] },
    list_collections: { collections: [] },
    list_projects: { projects: [] },
    // 页面的 refresh 会读 overview.embedder.id,夹具缺它就会在挂载钩子里抛未处理的异常(断言照过,但 vitest 退出码是 1)
    stats_overview: { totals: { rows: 0 }, jobs: { queued: 0, running: 0 }, drafts_pending: 0, collections: [], embedder: { id: 'fastembed:bge-m3-int8', dim: 1024, state: 'ready', error: null } },
    job_list: { jobs: [] },
    list_ingest: { total: 0, files: [] },
    get_config: {},
    system_status: {},
    sync_source: { queued: 1, job_id: 'j' },
    ...overrides,
  }
  callCapability.mockImplementation(async (name: string) => {
    const reply = replies[name]
    if (reply instanceof Error) throw reply
    return reply ?? {}
  })
}
const $ = <T extends Element = HTMLElement>(selector: string) => document.body.querySelector<T>(selector)
const $$ = (selector: string) => [...document.body.querySelectorAll<HTMLElement>(selector)]
const calls = (name: string) => callCapability.mock.calls.filter((call) => call[0] === name)

let wrapper: VueWrapper | null = null
async function open() {
  window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined })) as unknown as typeof window.matchMedia
  wrapper = mount(Projects, { attachTo: document.body })
  await flushPromises()
  await flushPromises()
}

beforeEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  callCapability.mockReset()
  setActivePinia(createPinia())
  backend()
})

describe('Projects · 服务器目录与 Git 来源', () => {
  it('只列服务器目录和 Git;网页 / 上传不在这里(那是「导入」页的)', async () => {
    await open()
    const names = $$('[data-testid=server-sources] [data-testid=rt-row] .kb-srct-title').map((el) => el.textContent!.trim())
    expect(names).toEqual(['来源 dir1', '来源 git1'])
    expect($('[data-testid=server-sources]')!.textContent).toContain('只有管理员能添加')
    expect($('[data-testid=server-sources]')!.textContent).not.toContain('web1')
  })

  it('「全部同步」只同步这两类', async () => {
    await open()
    $<HTMLButtonElement>('[data-testid=server-sync-all]')!.click()
    await flushPromises()
    expect(calls('sync_source').map((call) => (call[1] as { id: string }).id)).toEqual(['dir1', 'git1'])
  })

  it('「添加来源」只给服务器目录和 Git 两种,默认服务器目录', async () => {
    await open()
    $<HTMLButtonElement>('[data-testid=server-add]')!.click()
    await flushPromises()
    const types = $$('.kb-add-types .stype').map((el) => el.textContent!.replace(/\s+/g, ' ').trim())
    expect(types).toHaveLength(2)
    expect(types.join('|')).toMatch(/服务器目录/)
    expect(types.join('|')).toMatch(/Git/)
    expect($('.kb-add-types .stype.on')!.textContent).toContain('服务器目录')
  })

  it('没有任何服务器来源:给空状态说明,「全部同步」灰着', async () => {
    backend({ list_sources: { sources: [source('web1', 'web')], items: [] } })
    await open()
    expect($('[data-testid=server-sources]')!.textContent).toContain('还没有服务器目录或 Git 来源')
    expect($<HTMLButtonElement>('[data-testid=server-sync-all]')!.disabled).toBe(true)
  })

  it('读取来源失败:这一块整块报错并给重试,页面别的部分不受影响', async () => {
    backend({ list_sources: new Error('boom') })
    await open()
    expect($('[data-testid=server-sources-error]')!.textContent).toContain('没能读取数据来源')
    expect(document.body.textContent).toContain('项目与集合')
  })
})
