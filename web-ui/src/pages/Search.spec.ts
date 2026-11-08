// 搜索页:简单模式是默认(调试项折进「高级选项」)、共享范围、结果来源、点结果去哪、手机上的高级选项弹层。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { reactive } from 'vue'
import { KbSelect, KbSwitch, PHONE_QUERY } from '@kb-ui/index'

const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  callCapability: (...args: unknown[]) => callCapability(...args),
}))
const push = vi.fn()
const replace = vi.fn()
const route = reactive<{ query: Record<string, string> }>({ query: {} })
vi.mock('vue-router', () => ({ useRoute: () => route, useRouter: () => ({ push, replace }) }))
vi.mock('@/layouts/AppShell.vue', () => ({ default: { template: '<div class="app-shell"><slot /></div>' } }))

import { CapabilityError } from '@/api/client'
import SearchAdvanced from '@/components/search/SearchAdvanced.vue'
import { useSessionStore } from '@/stores/session'
import { PREFS_KEY } from '@/utils/search'
import Search from './Search.vue'

const alice = { id: 'usr_alice', username: 'alice', display_name: 'Alice', avatar: null }
const explainInfo = { store_rank: 1, fused_rank: 1, fts_rank: 1, fts_score: 2.1, vector_rank: 2, vector_score: 0.8, fused_score: 0.03, fused_weight: 1, rerank_rank: 1, window: null }
const hit = (id: string, kind: string, extra: Record<string, unknown> = {}) => ({ id, collection: 'proj/insights', kind, source: `docs/${id}.md`, start_line: null, end_line: null, symbol: null, title: `标题 ${id}`, snippet: `关于 ${id} 的片段`, score: 0.9, related: [], explain: explainInfo, ...extra })
const sharedItem = { target: { kind: 'insight', space_id: 'sp_alice', collection: 'c', id: 'k1' }, key: 'k1', title: '共享', role: 'editor', owner: alice, shared_at: 1, expires_at: null, hidden: false }

let replies: Record<string, unknown> = {}
function backend(overrides: Record<string, unknown> = {}) {
  replies = {
    list_projects: { projects: [{ project: { name: 'knowledgeBase' } }] },
    get_config: { search: { rrf_k: 60 } },
    shared_with_me: { items: [] },
    search_knowledge: { hits: [hit('a', 'insight'), hit('b', 'doc')], scope: ['knowledgeBase'], query_parsed: {}, degraded: null },
    search_shared: {
      hits: [
        hit('m', 'doc', { space_id: 'sp_me', role: 'owner', explain: null }),
        hit('s', 'insight', { space_id: 'sp_alice', owner: alice, role: 'editor', explain: null }),
        hit('f', 'doc', { space_id: 'sp_alice', owner: alice, role: 'viewer', explain: null, source: 'guide/run.md' }),
      ],
      sources: [],
      query: 'x',
    },
    ...overrides,
  }
  callCapability.mockImplementation(async (name: string) => {
    const reply = replies[name]
    if (reply instanceof Error) throw reply
    return reply ?? {}
  })
}
const calls = (name: string) => callCapability.mock.calls.filter((call) => call[0] === name)
const lastArgs = (name: string) => calls(name).at(-1)?.[1] as Record<string, unknown>
const $ = <T extends Element = HTMLElement>(selector: string) => document.body.querySelector<T>(selector)
const $$ = (selector: string) => [...document.body.querySelectorAll<HTMLElement>(selector)]

function setViewport(phone: boolean, wide = false) {
  window.matchMedia = ((query: string) => ({
    matches: phone ? query === PHONE_QUERY : wide && query === '(min-width: 1280px)',
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia
}
let wrapper: VueWrapper | null = null
async function open(features = ['search.basic', 'search.deep'], options: { phone?: boolean; wide?: boolean } = {}) {
  setViewport(options.phone ?? false, options.wide ?? false)
  const session = useSessionStore()
  session.user = { id: 'usr_me', username: 'me', display_name: '我', email: null, role_id: 'r', space_id: null, must_change_password: false }
  session.features = new Set(features)
  session.loaded = true
  wrapper = mount(Search, { attachTo: document.body })
  await flushPromises()
}
async function search(text = '部署') {
  await wrapper!.find('input.kb-searchbar-input').setValue(text)
  await wrapper!.find('form').trigger('submit')
  await flushPromises()
}
const scopeSelect = () => wrapper!.findAllComponents(KbSelect)[0]!
const advancedSwitches = () => wrapper!.findComponent(SearchAdvanced).findAllComponents(KbSwitch)

beforeEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  localStorage.clear()
  callCapability.mockReset()
  push.mockClear()
  replace.mockClear()
  route.query = {}
  setActivePinia(createPinia())
  backend()
})

describe('Search 搜索页 · 简单模式', () => {
  it('默认只给搜索框、范围、只看笔记、深度检索和「高级选项」:页面上没有 rerank / explain / RRF / top-k 这些词', async () => {
    await open()
    expect($('[data-testid=search-advanced]')).toBeNull()
    const text = document.body.textContent!
    for (const word of ['rerank', 'explain', 'RRF', 'top-k', '演练场']) expect(text, word).not.toContain(word)
    expect(text).toContain('高级选项')
    expect(text).toContain('深度检索')
  })

  it('默认不查排序依据:请求取满 100 条(翻页在页面里切)、explain:false、重排开着时不明说;结果里没有阶段名次和右侧说明面板', async () => {
    await open()
    await search()
    expect(lastArgs('search_knowledge')).toMatchObject({ query: '部署', k: 100, explain: false })
    expect(lastArgs('search_knowledge')).not.toHaveProperty('rerank')
    expect($$('[data-testid=hit-kind]').map((el) => el.textContent!.trim())).toEqual(['笔记', '文档'])
    expect($$('.kb-stg-cell')).toHaveLength(0)
    expect($('.kb-explain')).toBeNull()
    expect($$('.kb-hit-id')).toHaveLength(0)
  })

  it('每条结果标出来源:自己的知识库写「我的」', async () => {
    await open()
    await search()
    expect($$('[data-testid=hit-source]').map((el) => el.textContent!.trim())).toEqual(['我的', '我的'])
  })

  it('结果里出现了查询词:对应处高亮,不显示"语义相关"提示', async () => {
    await open()
    await search('片段')
    expect($$('.kb-hit-snippet mark.hl').map((el) => el.textContent)).toEqual(['片段', '片段'])
    expect($$('[data-testid=hit-semantic]')).toHaveLength(0)
  })

  it('一个词都没出现的纯语义命中:说明没有可高亮的地方,而不是让高亮看起来坏了', async () => {
    await open()
    await search('部署')
    expect($$('.kb-hit-snippet mark.hl')).toHaveLength(0)
    const hints = $$('[data-testid=hit-semantic]')
    expect(hints).toHaveLength(2)
    expect(hints[0]!.textContent).toContain('语义匹配')
    expect(hints[0]!.getAttribute('title')).toContain('按意思匹配')
  })

  it('边输入边搜:停顿后自动检索,不写搜索历史;紧接着回车不会再发一次', async () => {
    await open()
    const input = wrapper!.find('input.kb-searchbar-input')
    await input.setValue('部署')
    // 打字当下不请求,等停顿
    expect(calls('search_knowledge')).toHaveLength(0)
    await new Promise((resolve) => setTimeout(resolve, 420))
    await flushPromises()
    expect(calls('search_knowledge')).toHaveLength(1)
    expect(lastArgs('search_knowledge')).toMatchObject({ query: '部署' })
    // 自动补全的请求不记历史:否则每打一个字都会多一条
    expect(localStorage.getItem('kb.search.recent')).toBeNull()

    // 新词还没到 280ms 就回车:计时器被取消,只发一次
    await input.setValue('架构')
    await wrapper!.find('form').trigger('submit')
    await flushPromises()
    expect(calls('search_knowledge')).toHaveLength(2)
    expect(JSON.parse(localStorage.getItem('kb.search.recent') ?? '[]')).toEqual(['架构'])
    await new Promise((resolve) => setTimeout(resolve, 350))
    await flushPromises()
    expect(calls('search_knowledge')).toHaveLength(2)
  })

  it('窄屏不显示右侧预览,结果列表直接占满', async () => {
    await open()
    await search()
    expect($('[data-testid=search-preview]')).toBeNull()
  })

  it('宽屏右侧给当前结果的预览,点「打开这条」进文档', async () => {
    await open(undefined, { wide: true })
    await search()
    const preview = $('[data-testid=search-preview]')!
    expect(preview.textContent).toContain('预览')
    expect(preview.textContent).toContain('标题 a')
    preview.querySelector('button')!.click()
    await flushPromises()
    expect(push).toHaveBeenCalled()
  })

  it('开始搜索前显示「还没有搜索」,搜索中是骨架屏,没有找到时给下一步', async () => {
    await open()
    expect(document.body.textContent).toContain('还没有搜索')
    backend({ search_knowledge: { hits: [], scope: [], query_parsed: {}, degraded: null } })
    await search()
    expect($('[data-testid=search-none]')!.textContent).toContain('没有找到相关内容')
  })
})

const many = (count: number) =>
  Array.from({ length: count }, (_, at) => hit(`h${String(at + 1).padStart(3, '0')}`, 'doc', { title: `标题 ${at + 1}`, snippet: `第 ${at + 1} 条的片段`, explain: null }))

describe('Search 搜索页 · 翻页', () => {
  async function openWith(count: number, extra: Record<string, unknown> = {}) {
    backend({ search_knowledge: { hits: many(count), scope: ['knowledgeBase'], query_parsed: {}, degraded: null, ...extra } })
    await open()
    await search('片段')
  }
  const titles = () => $$('.kb-hit-title').map((el) => el.textContent!.trim())
  const ranks = () => $$('.kb-hit-rank').map((el) => el.textContent!.trim())

  it('一次向服务器取满 100 条,页面每页只显示 10 条,下面有翻页条', async () => {
    await openWith(35)
    expect(lastArgs('search_knowledge')).toMatchObject({ k: 100 })
    expect(titles()).toHaveLength(10)
    expect(ranks()[0]).toBe('1')
    expect($('[data-testid=search-pager]')!.textContent).toContain('35 条中第 1–10 条')
    expect($('.kb-search-stat')!.textContent).toContain('35 条')
  })

  it('翻页不重新搜索:第 2 页接着是第 11 条,名次是全部结果里的名次', async () => {
    await openWith(35)
    const before = calls('search_knowledge').length
    ;(wrapper!.findComponent({ name: 'KbPager' }).vm as unknown as { $emit: (name: string, value: number) => void }).$emit('update:page', 2)
    await flushPromises()
    expect(calls('search_knowledge')).toHaveLength(before)
    expect(ranks()[0]).toBe('11')
    expect(titles()[0]).toBe('标题 11')
    expect($('[data-testid=search-pager]')!.textContent).toContain('35 条中第 11–20 条')
  })

  it('每页条数可切换(10 / 20 / 50),切换后回第一页、记住选择、不重新搜索', async () => {
    await openWith(35)
    const before = calls('search_knowledge').length
    ;(wrapper!.findComponent({ name: 'KbPager' }).vm as unknown as { $emit: (name: string, value: number) => void }).$emit('update:pageSize', 20)
    await flushPromises()
    expect(titles()).toHaveLength(20)
    expect(calls('search_knowledge')).toHaveLength(before)
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!).pageSize).toBe(20)
  })

  it('结果不到一页:没有翻页条', async () => {
    await openWith(4)
    expect($('[data-testid=search-pager]')).toBeNull()
    expect(titles()).toHaveLength(4)
  })

  it('取满了上限(100 条):说明最多显示这些,统计里的条数带 + 号', async () => {
    await openWith(100)
    expect($('[data-testid=search-capped]')!.textContent).toContain('最多显示最相关的 100 条')
    expect($('.kb-search-stat')!.textContent).toContain('100+ 条')
  })

  it('↓ 越过本页最后一条自动翻到下一页', async () => {
    await openWith(25)
    for (let step = 0; step < 10; step++) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
    await flushPromises()
    expect(ranks()[0]).toBe('11')
    expect($('.kb-hit.is-selected .kb-hit-rank')!.textContent).toBe('11')
  })

  it('新搜一次回到第一页', async () => {
    await openWith(35)
    ;(wrapper!.findComponent({ name: 'KbPager' }).vm as unknown as { $emit: (name: string, value: number) => void }).$emit('update:page', 3)
    await flushPromises()
    await search('另一个词')
    expect(ranks()[0]).toBe('1')
  })
})

describe('Search 搜索页 · 降级提示', () => {
  it('没装重排模型:不再露出"rerank_unavailable"这种内部代号,而是一句说明', async () => {
    backend({ search_knowledge: { hits: [hit('a', 'doc')], scope: [], query_parsed: {}, degraded: 'rerank_unavailable' } })
    await open()
    await search()
    const banner = $('[data-testid=search-degraded]')!
    expect(banner.textContent).toContain('没有启用重排模型')
    expect(banner.textContent).not.toContain('rerank_unavailable')
    expect(banner.textContent).not.toContain('已降级')
  })

  it('语义模型在加载:说明这次只按关键词匹配、过几秒再搜', async () => {
    backend({ search_knowledge: { hits: [hit('a', 'doc')], scope: [], query_parsed: {}, degraded: 'embedder_loading' } })
    await open()
    await search()
    expect($('[data-testid=search-degraded]')!.textContent).toContain('再搜一次')
  })

  it('没有降级就没有提示', async () => {
    await open()
    await search()
    expect($('[data-testid=search-degraded]')).toBeNull()
  })
})

describe('Search 搜索页 · 高级选项', () => {
  it('点「高级选项」展开:重排、查看排序依据,术语表的说法;每页几条不在这里;再点收起', async () => {
    await open()
    await wrapper!.find('[data-testid=search-adv-toggle]').trigger('click')
    const panel = $('[data-testid=search-advanced]')!
    for (const word of ['重排', '查看排序依据']) expect(panel.textContent, word).toContain(word)
    expect(panel.textContent).not.toContain('返回条数')
    expect(wrapper!.find('[data-testid=search-adv-toggle]').attributes('aria-expanded')).toBe('true')
    await wrapper!.find('[data-testid=search-adv-toggle]').trigger('click')
    expect($('[data-testid=search-advanced]')).toBeNull()
  })

  it('打开「查看排序依据」:重新带 explain:true 去搜,结果出现各阶段名次和右侧说明面板;设置被记住', async () => {
    await open()
    await wrapper!.find('[data-testid=search-adv-toggle]').trigger('click')
    advancedSwitches()[1]!.vm.$emit('update:modelValue', true)
    await flushPromises()
    await search()
    expect(lastArgs('search_knowledge').explain).toBe(true)
    expect($$('.kb-stg-cell').length).toBeGreaterThan(0)
    expect($('.kb-explain')).not.toBeNull()
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!)).toEqual({ rerank: true, explain: true, pageSize: 10 })
  })

  it('Explain 面板的各阶段耗时画成横向条,文字(阶段名 + 毫秒)保持原样;额外两趟用灰色并有说明', async () => {
    const timings = { parse_ms: 0.4, embed_ms: 38.25, store_ms: 3, fts_ms: 5.5, vector_ms: 12, fuse_ms: 0.1, rerank_ms: 90, total_ms: 150 }
    backend({ search_knowledge: { hits: [hit('a', 'insight')], scope: ['knowledgeBase'], query_parsed: {}, degraded: null, timings } })
    await open()
    await wrapper!.find('[data-testid=search-adv-toggle]').trigger('click')
    advancedSwitches()[1]!.vm.$emit('update:modelValue', true)
    await flushPromises()
    await search()
    const panel = $('[data-testid=explain-timings]')!
    expect(panel).not.toBeNull()
    const rows = [...panel.querySelectorAll('.kb-hbars-row')].map((row) => row.querySelector('.kb-hbars-head')!.textContent!.replace(/\s+/g, ' ').trim())
    expect(rows).toEqual(['解析 / 前缀0.4 ms', '嵌入38.3 ms', 'BM25 (explain 额外)5.5 ms', '向量 (explain 额外)12.0 ms', 'RRF 融合0.1 ms', '重排90.0 ms'])
    expect(panel.textContent).toContain('灰色的两项是查看排序依据时额外多跑的两趟')
    // 后端没给耗时(老后端)时整块不出现
    backend({ search_knowledge: { hits: [hit('a', 'insight')], scope: ['knowledgeBase'], query_parsed: {}, degraded: null } })
    await search()
    expect($('[data-testid=explain-timings]')).toBeNull()
  })

  it('搜过之后再改高级选项:马上按新设置重搜,不用再点一次搜索', async () => {
    await open()
    await search()
    expect(calls('search_knowledge')).toHaveLength(1)
    expect($$('.kb-stg-cell')).toHaveLength(0)
    await wrapper!.find('[data-testid=search-adv-toggle]').trigger('click')
    advancedSwitches()[1]!.vm.$emit('update:modelValue', true)
    await flushPromises()
    expect(calls('search_knowledge')).toHaveLength(2)
    expect(lastArgs('search_knowledge')).toMatchObject({ query: '部署', explain: true })
    expect($$('.kb-stg-cell').length).toBeGreaterThan(0)
  })

  it('还没搜过就改高级选项:不发任何搜索', async () => {
    await open()
    await wrapper!.find('[data-testid=search-adv-toggle]').trigger('click')
    advancedSwitches()[0]!.vm.$emit('update:modelValue', false)
    await flushPromises()
    expect(calls('search_knowledge')).toHaveLength(0)
  })

  it('正在搜的时候又改了设置:等这一次结束后按最新设置补一次,不丢也不叠', async () => {
    await open()
    let release: () => void = () => undefined
    callCapability.mockImplementation(async (name: string) => {
      if (name === 'search_knowledge') {
        await new Promise<void>((resolve) => (release = resolve))
        return replies.search_knowledge
      }
      return replies[name] ?? {}
    })
    await wrapper!.find('input.kb-searchbar-input').setValue('部署')
    await wrapper!.find('form').trigger('submit')
    await flushPromises()
    await wrapper!.find('[data-testid=search-adv-toggle]').trigger('click')
    // 两次改动各占一个 tick(真人点开关不会在同一瞬间点两个)
    advancedSwitches()[1]!.vm.$emit('update:modelValue', true)
    await flushPromises()
    advancedSwitches()[0]!.vm.$emit('update:modelValue', false)
    await flushPromises()
    expect(calls('search_knowledge')).toHaveLength(1)
    release()
    await flushPromises()
    release()
    await flushPromises()
    expect(calls('search_knowledge')).toHaveLength(2)
    expect(lastArgs('search_knowledge')).toMatchObject({ explain: true, rerank: false })
  })

  it('以前存过的高级选项下次打开还在:关掉重排会明说 rerank:false;老版本存的"返回条数"沿用成每页条数', async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ rerank: false, explain: false, k: 20 }))
    await open()
    await search()
    expect(lastArgs('search_knowledge')).toMatchObject({ rerank: false, k: 100, explain: false })
  })

  it('改过高级选项时,折叠着的按钮上有角标提醒', async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ rerank: false, explain: true, pageSize: 10 }))
    await open()
    expect(wrapper!.find('[data-testid=search-adv-toggle]').text()).toContain('2')
  })

  it('融合参数只给有「检索调优」权限的人看', async () => {
    await open(['search.basic'])
    await wrapper!.find('[data-testid=search-adv-toggle]').trigger('click')
    expect($('[data-testid=adv-rrf]')).toBeNull()
    wrapper!.unmount()
    document.body.innerHTML = ''
    await open(['search.basic', 'search.tune'])
    await wrapper!.find('[data-testid=search-adv-toggle]').trigger('click')
    expect($('[data-testid=adv-rrf]')!.textContent).toContain('60')
  })

  it('手机上高级选项在底部弹层里,不是内联展开', async () => {
    await open(['search.basic'], { phone: true })
    await wrapper!.find('[data-testid=search-adv-toggle]').trigger('click')
    await flushPromises()
    expect($('.kb-sheet')).not.toBeNull()
    expect($('.kb-sheet')!.textContent).toContain('查看排序依据')
    expect(wrapper!.find('.kb-search-adv').exists()).toBe(false)
  })

  it('深度检索是 AI 功能:没有 search.deep 就不显示', async () => {
    await open(['search.basic'])
    expect(document.body.textContent).not.toContain('深度检索')
  })
})

describe('Search 搜索页 · 共享范围', () => {
  it('没有人分享内容给我:范围里没有「共享」选项', async () => {
    await open()
    expect(scopeSelect().props('options').map((option) => option.value)).toEqual(['auto:', 'auto:knowledgeBase', 'all:', 'global:'])
  })

  it('有共享:多出「我的 + 共享给我的」「只搜共享给我的」;被我移出列表的不算', async () => {
    backend({ shared_with_me: { items: [{ ...sharedItem, hidden: true }] } })
    await open()
    expect(scopeSelect().props('options').some((option) => String(option.value).startsWith('shared:'))).toBe(false)
    wrapper!.unmount()
    document.body.innerHTML = ''
    backend({ shared_with_me: { items: [sharedItem] } })
    await open()
    expect(scopeSelect().props('options').slice(-2).map((option) => option.value)).toEqual(['shared:all', 'shared:only'])
  })

  it('共享列表的响应里没有 items(老后端 / 被代理改写)按「没有共享」处理,搜索照常可用', async () => {
    backend({ shared_with_me: {} })
    // 带 ?q= 打开会在挂载时自动搜索;挂载流程里取共享列表若抛错,这次自动搜索就被跳过了(浏览器场景里抓到过)
    route.query = { q: '部署' }
    await open()
    expect(scopeSelect().props('options').some((option) => String(option.value).startsWith('shared:'))).toBe(false)
    expect($$('article.kb-hit')).toHaveLength(2)
  })

  it('取共享列表失败也不挡住搜索', async () => {
    backend({ shared_with_me: new CapabilityError('internal: x', 'internal', 500) })
    await open()
    await search()
    expect($$('article.kb-hit')).toHaveLength(2)
  })

  it('选「我的 + 共享给我的」:走 search_shared(scope=all),不再走普通检索;结果标出分享人和我的角色,别人的结果没有「有用 / 无用」', async () => {
    backend({ shared_with_me: { items: [sharedItem] } })
    await open()
    scopeSelect().vm.$emit('update:modelValue', 'shared:all')
    await flushPromises()
    await search('周报')
    expect(calls('search_knowledge')).toHaveLength(0)
    expect(lastArgs('search_shared')).toEqual({ query: '周报', scope: 'all', k: 50 })
    expect($$('[data-testid=hit-source]').map((el) => el.textContent!.replace(/\s+/g, ' ').trim())).toEqual(['我的', '来自 Alice · 可编辑', '来自 Alice · 可查看'])
    const cards = $$('article.kb-hit')
    expect(cards[0]!.querySelector('[data-testid=hit-useful]')).not.toBeNull()
    expect(cards[0]!.querySelector('[data-testid=hit-useless]')).not.toBeNull()
    expect(cards[1]!.querySelector('[data-testid=hit-useful]')).toBeNull()
    expect(cards[1]!.querySelector('[data-testid=hit-useless]')).toBeNull()
  })

  it('选「只搜共享给我的」:scope=shared', async () => {
    backend({ shared_with_me: { items: [sharedItem] } })
    await open()
    scopeSelect().vm.$emit('update:modelValue', 'shared:only')
    await flushPromises()
    await search()
    expect(lastArgs('search_shared').scope).toBe('shared')
  })

  it('共享检索报错(例如来源太多)把后端的话原样告诉用户,并能重试', async () => {
    backend({ shared_with_me: { items: [sharedItem] }, search_shared: new CapabilityError('invalid input: 共享给你的来源有 25 个,一次最多搜 20 个,请选一个人再搜', 'invalid_input', 400) })
    await open()
    scopeSelect().vm.$emit('update:modelValue', 'shared:only')
    await flushPromises()
    await search()
    expect($('[data-testid=search-error]')!.textContent).toContain('一次最多搜 20 个')
    backend({ shared_with_me: { items: [sharedItem] } })
    $<HTMLButtonElement>('[data-testid=search-error] button')!.click()
    await flushPromises()
    expect($('[data-testid=search-error]')).toBeNull()
    expect($$('article.kb-hit')).toHaveLength(3)
  })
})

describe('Search 搜索页 · 范围在地址里', () => {
  it('搜过之后范围写进地址(默认范围不写),后退回来才能恢复同一批结果', async () => {
    backend({ shared_with_me: { items: [sharedItem] } })
    await open()
    await search('周报')
    expect(replace.mock.calls.at(-1)![0]).toEqual({ query: { q: '周报' } })
    scopeSelect().vm.$emit('update:modelValue', 'shared:only')
    await flushPromises()
    expect(replace.mock.calls.at(-1)![0]).toEqual({ query: { q: '周报', scope: 'shared:only' } })
  })

  it('带 ?scope= 打开:按地址里的范围自动搜(后退回来的场景),不是退回「当前项目」', async () => {
    backend({ shared_with_me: { items: [sharedItem] } })
    route.query = { q: '部署', scope: 'shared:only' }
    await open()
    expect(calls('search_knowledge')).toHaveLength(0)
    expect(lastArgs('search_shared')).toEqual({ query: '部署', scope: 'shared', k: 50 })
    expect(scopeSelect().props('modelValue')).toBe('shared:only')
  })

  it('地址里的范围已经不能选(共享被收回了):退回「当前项目」,不拿它去搜', async () => {
    route.query = { q: '部署', scope: 'shared:all' }
    await open()
    expect(calls('search_shared')).toHaveLength(0)
    expect(lastArgs('search_knowledge')).toMatchObject({ query: '部署' })
    expect(scopeSelect().props('modelValue')).toBe('auto:')
  })

  it('搜过之后换范围:马上按新范围重搜', async () => {
    backend({ shared_with_me: { items: [sharedItem] } })
    await open()
    await search('周报')
    scopeSelect().vm.$emit('update:modelValue', 'shared:all')
    await flushPromises()
    expect(lastArgs('search_shared')).toEqual({ query: '周报', scope: 'all', k: 50 })
    expect($$('article.kb-hit')).toHaveLength(3)
  })

  it('还没搜过就换范围:不发搜索', async () => {
    backend({ shared_with_me: { items: [sharedItem] } })
    await open()
    scopeSelect().vm.$emit('update:modelValue', 'shared:all')
    await flushPromises()
    expect(calls('search_shared')).toHaveLength(0)
    expect(calls('search_knowledge')).toHaveLength(0)
  })
})

describe('Search 搜索页 · 键盘', () => {
  const press = (init: KeyboardEventInit) => window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }))

  it('按 / 聚焦搜索框;带 Shift 的斜杠(「?」)不抢焦点', async () => {
    await open()
    const input = wrapper!.find('input.kb-searchbar-input').element as HTMLInputElement
    input.blur()
    press({ key: '/', shiftKey: true })
    expect(document.activeElement).not.toBe(input)
    press({ key: '/' })
    expect(document.activeElement).toBe(input)
  })
})

describe('Search 搜索页 · 点结果', () => {
  it('我的结果:用路径地址去知识库页(路由表里没有命名路由,用 name 会抛 No match)', async () => {
    await open()
    await search()
    $$('[data-testid=hit-open]')[0]!.click()
    expect(push).toHaveBeenCalledTimes(1)
    const target = push.mock.calls[0]![0] as Record<string, unknown>
    expect(target.path).toBe('/kb')
    expect(target.query).toEqual(expect.objectContaining({ collection: 'proj/insights', path: 'docs/a.md', highlight: 'a' }))
    expect((target.query as Record<string, string>).hq).toBeTruthy()
    expect('name' in target).toBe(false)
  })

  it('别人分享的笔记 / 文件:切到「共享给我」,笔记带 item,文件带 path', async () => {
    backend({ shared_with_me: { items: [sharedItem] } })
    await open()
    scopeSelect().vm.$emit('update:modelValue', 'shared:only')
    await flushPromises()
    await search()
    const buttons = $$('[data-testid=hit-open]')
    buttons[1]!.click()
    expect(push.mock.calls.at(-1)![0]).toEqual({ path: '/kb', query: { scope: 'shared', space: 'sp_alice', collection: 'proj/insights', item: 's', hq: expect.any(String) } })
    buttons[2]!.click()
    expect(push.mock.calls.at(-1)![0]).toEqual({ path: '/kb', query: { scope: 'shared', space: 'sp_alice', collection: 'proj/insights', path: 'guide/run.md', hq: expect.any(String) } })
  })

  it('普通检索失败:显示原因并给「重试」', async () => {
    backend({ search_knowledge: new CapabilityError('internal: boom', 'internal', 500) })
    await open()
    await search()
    expect($('[data-testid=search-error]')).not.toBeNull()
    backend()
    $<HTMLButtonElement>('[data-testid=search-error] button')!.click()
    await flushPromises()
    expect($('[data-testid=search-error]')).toBeNull()
    expect($$('article.kb-hit')).toHaveLength(2)
  })
})

describe('Search 搜索页 · 搜索历史下拉面板', () => {
  it('点击输入框且有历史记录时弹出下拉面板，支持点选、单条删除、清空和快捷键', async () => {
    localStorage.setItem('kb.search.recent', JSON.stringify(['部署', '架构', '向量检索']))
    await open()
    const input = wrapper!.find('input.kb-searchbar-input')

    // 未点击/聚焦时不显示历史面板
    expect(wrapper!.find('[data-testid=search-history-panel]').exists()).toBe(false)

    // 点击输入框，显示历史面板（只是聚焦 / Tab 进来不弹，避免挡住结果）
    await input.trigger('click')
    expect(wrapper!.find('[data-testid=search-history-panel]').exists()).toBe(true)
    const items = wrapper!.findAll('[data-testid=search-history-item]')
    expect(items).toHaveLength(3)
    expect(items[0]!.text()).toContain('部署')
    expect(items[1]!.text()).toContain('架构')
    expect(items[2]!.text()).toContain('向量检索')

    // 键盘移动高亮并回车选中
    await input.trigger('keydown', { key: 'ArrowDown' })
    expect(items[0]!.classes()).toContain('is-active')
    await input.trigger('keydown', { key: 'ArrowDown' })
    expect(items[1]!.classes()).toContain('is-active')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(lastArgs('search_knowledge')).toMatchObject({ query: '架构' })
    expect(wrapper!.find('[data-testid=search-history-panel]').exists()).toBe(false)

    // 再次点击并测试删除单条记录
    await input.trigger('click')
    expect(wrapper!.findAll('[data-testid=search-history-item]')).toHaveLength(3)
    const delBtns = wrapper!.findAll('[data-testid=search-history-del]')
    await delBtns[0]!.trigger('mousedown')
    await flushPromises()
    const remaining = wrapper!.findAll('[data-testid=search-history-item]')
    expect(remaining).toHaveLength(2)
    expect(remaining.map((el) => el.text())).not.toContain('架构')
    expect(JSON.parse(localStorage.getItem('kb.search.recent') ?? '[]')).toEqual(['部署', '向量检索'])

    // 点击清空全部
    await wrapper!.find('[data-testid=search-history-clear]').trigger('mousedown')
    await flushPromises()
    expect(wrapper!.find('[data-testid=search-history-panel]').exists()).toBe(false)
    expect(localStorage.getItem('kb.search.recent')).toBeNull()
  })

  it('点击外部或按 Escape 收起历史面板', async () => {
    localStorage.setItem('kb.search.recent', JSON.stringify(['Docker']))
    await open()
    const input = wrapper!.find('input.kb-searchbar-input')

    await input.trigger('click')
    expect(wrapper!.find('[data-testid=search-history-panel]').exists()).toBe(true)

    await input.trigger('keydown', { key: 'Escape' })
    expect(wrapper!.find('[data-testid=search-history-panel]').exists()).toBe(false)

    await input.trigger('click')
    expect(wrapper!.find('[data-testid=search-history-panel]').exists()).toBe(true)

    document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await flushPromises()
    expect(wrapper!.find('[data-testid=search-history-panel]').exists()).toBe(false)
  })
})
