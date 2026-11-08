// 详情面板(历史版本 / 评论)、文件预览、保存都按「文档自己的集合」取数。
//
// 左侧筛选框里的集合不一定是当前文档所在的集合:从首页、搜索结果、「全部」,或别的集合里的
// 链接点进来时,筛选值还停在上一次选的集合。以前的实现用的是筛选值,于是这些入口打开的笔记
// 在详情里显示「历史版本 0」、文件预览打不开 —— 数据其实一直都在。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

/** URL 上的查询串:每个用例按需改 */
const routeQuery = vi.hoisted(() => ({ value: {} as Record<string, string> }))
/** 记下每次能力调用的参数,断言「用的是哪个集合」 */
const calls = vi.hoisted(() => [] as { name: string; args: Record<string, unknown> }[])
/** 每个能力按用例给响应;没给就返回空对象 */
const handlers = vi.hoisted(() => ({}) as Record<string, (args: Record<string, unknown>) => unknown>)

vi.mock('@/api/client', () => ({
  CapabilityError: class CapabilityError extends Error {
    status = 400
  },
  callCapability: vi.fn(async (name: string, args: Record<string, unknown> = {}) => {
    calls.push({ name, args })
    return handlers[name]?.(args) ?? {}
  }),
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/kb', query: routeQuery.value, meta: {} }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  RouterLink: { name: 'RouterLink', props: ['to'], template: '<a><slot /></a>' },
}))
// 页面框架只负责把标题 / 操作传送进顶栏,与这里要测的无关
vi.mock('@/layouts/AppShell.vue', () => ({ default: { template: '<div class="app-shell"><slot /></div>' } }))

import Browser from './Browser.vue'
import { useSessionStore } from '@/stores/session'

const COLLECTIONS = {
  collections: [
    { name: '_global', rows: 3, files: 3, insights: 1, size: 0 },
    { name: 'proj_probe', rows: 2, files: 2, insights: 1, size: 0 },
  ],
}

// 左侧筛选停在 proj_probe,打开的却是 _global 里的文档
function setUp(item: Record<string, unknown>) {
  handlers.list_collections = () => COLLECTIONS
  handlers.list_items = () => ({ items: [], total: 0, page: 1, page_size: 20 })
  handlers.item_facets = () => ({ kinds: [] })
  handlers.get_item = () => ({ item })
  handlers.item_history = () => ({ items: [] })
  handlers.file_versions = () => ({ versions: [] })
  handlers.list_annotations = () => ({ annotations: [] })
  handlers.file_preview = () => ({ format: 'text', blocks: [], chunks: [], content: '正文' })
  handlers.doc_links = () => ({ links: [] })
  routeQuery.value = { collection: 'proj_probe', item: String(item.id) }

  const session = useSessionStore()
  session.user = { id: 'u1', username: 'alice', display_name: 'Alice', email: '', role_id: 'r', space_id: null, must_change_password: false } as never
  session.features = new Set<string>()
  session.loaded = true

  return shallowMount(Browser, { props: {} })
}

function argsOf(name: string) {
  return calls.filter((entry) => entry.name === name).map((entry) => entry.args)
}

beforeEach(() => {
  calls.length = 0
  for (const key of Object.keys(handlers)) delete handlers[key]
  setActivePinia(createPinia())
})

describe('Browser 按文档自己的集合取数', () => {
  it('跨集合打开的笔记:历史版本查它自己的集合', async () => {
    setUp({ id: 'note-1', kind: 'insight', collection: '_global', title: '跨集合笔记', text: '正文', tags: [], source: 'insight:note-1' })
    await flushPromises()
    await flushPromises()
    await flushPromises()

    const versions = argsOf('file_versions')
    expect(versions.length).toBeGreaterThan(0)
    // 关键:不是左侧筛选的 proj_probe
    expect(versions.every((args) => args.collection === '_global')).toBe(true)
    expect(versions[0]?.path).toBe('insight:note-1')
  })

  it('跨集合打开的文件:评论也查它自己的集合', async () => {
    setUp({ id: 'file-1', kind: 'doc', collection: '_global', title: '说明', text: '正文', tags: [], source: 'docs/a.md' })
    await flushPromises()
    await flushPromises()

    const annotations = argsOf('list_annotations')
    expect(annotations.length).toBeGreaterThan(0)
    expect(annotations.every((args) => args.collection === '_global')).toBe(true)
  })

  it('跨集合打开的文件:预览查它自己的集合', async () => {
    setUp({ id: 'file-1', kind: 'doc', collection: '_global', title: '说明', text: '正文', tags: [], source: 'docs/a.md' })
    await flushPromises()
    await flushPromises()

    const previews = argsOf('file_preview')
    expect(previews.length).toBeGreaterThan(0)
    expect(previews.every((args) => args.collection === '_global')).toBe(true)
    expect(previews[0]?.path).toBe('docs/a.md')
  })
})
