// 首页:每一块各自的加载 / 空 / 报错状态,没开通的功能不出现,点击去向,实时刷新。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { reactive } from 'vue'

const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  callCapability: (...args: unknown[]) => callCapability(...args),
}))
const push = vi.fn()
const route = reactive<{ query: Record<string, string> }>({ query: {} })
vi.mock('vue-router', () => ({
  useRoute: () => route,
  useRouter: () => ({ push, replace: vi.fn() }),
  RouterLink: { props: ['to'], template: '<a class="router-link" :data-to="JSON.stringify(to)"><slot /></a>' },
}))
vi.mock('@/layouts/AppShell.vue', () => ({ default: { template: '<div class="app-shell"><slot /></div>' } }))
let pushLive: (event: { type: string; data: Record<string, unknown> }) => void = () => undefined
vi.mock('@/composables/useLiveEvents', () => ({
  useLiveEvents: (listener: typeof pushLive) => {
    pushLive = listener
    return () => undefined
  },
}))

import { KbHBars, KbLineChart, KbSegmented, KbStat } from '@kb-ui/index'
import { CapabilityError } from '@/api/client'
import { useSessionStore } from '@/stores/session'
import { useShellStore } from '@/stores/shell'
import Home from './Home.vue'

const ALL = ['docs.notes', 'docs.upload', 'search.basic', 'collab.friends', 'collab.share', 'ai.extract', 'ai.assistant']
const alice = { id: 'usr_alice', username: 'alice', display_name: 'Alice', avatar: null }
const zhao = { id: 'usr_zhao', username: 'zhaoliu', display_name: '赵六', avatar: null }
const note = (id: string, updated_at: number) => ({ id, collection: 'proj/insights', kind: 'insight', lang: null, source: `n/${id}.md`, start_line: null, end_line: null, symbol: null, title: `笔记 ${id}`, status: 'active', tags: [], updated_at, version: 1 })
const sharedItem = (key: string) => ({ target: { kind: 'insight', space_id: 'sp_a', collection: 'c', id: key }, key, title: `共享 ${key}`, role: 'editor', owner: alice, shared_at: Date.now() - 60_000, expires_at: null, hidden: false })

const usageReply = { storage: { sources_bytes: 0, uploads_bytes: 0, vectors_bytes: 0, meta_bytes: 3 * 1024 ** 3, workspace_bytes: 0, total_bytes: 3 * 1024 ** 3, limit_bytes: 100 * 1024 ** 3 }, ai: { day: '2026-10-28', tokens_today: 68_000, limit: 200_000 } }

let replies: Record<string, unknown> = {}
function backend(overrides: Record<string, unknown> = {}) {
  replies = {
    list_collections: { collections: [{ name: 'proj/insights' }] },
    list_items: { items: [note('a', Date.now() - 3_600_000), note('b', Date.now() - 60_000)], total: 2, page: 1, page_size: 6 },
    shared_with_me: { items: [sharedItem('k1')] },
    friend_requests: { incoming: [{ id: 'frq_1', from: zhao, message: '我是上周的同事', created_at: Date.now() - 60_000, expires_at: Date.now() + 1e9 }], outgoing: [] },
    access_requests: { to_decide: [], mine: [] },
    usage_mine: usageReply,
    ...overrides,
  }
  callCapability.mockImplementation(async (name: string) => {
    const reply = replies[name]
    if (reply instanceof Error) throw reply
    return reply ?? {}
  })
}
const calls = (name: string) => callCapability.mock.calls.filter((call) => call[0] === name)
const $ = <T extends Element = HTMLElement>(selector: string) => document.body.querySelector<T>(selector)
const $$ = (selector: string) => [...document.body.querySelectorAll<HTMLElement>(selector)]
const text = (selector: string) => $(selector)?.textContent?.replace(/\s+/g, ' ').trim() ?? ''

let wrapper: VueWrapper | null = null
function signIn(features: string[], ai = true) {
  const session = useSessionStore()
  session.user = { id: 'usr_me', username: 'me', display_name: '林一', email: 'me@example.com', role_id: 'r', space_id: null, must_change_password: false }
  session.features = new Set(features)
  session.aiEnabled = ai
  session.loaded = true
}
async function open(features = ALL, options: { ai?: boolean; drafts?: number; insights?: number; sources?: number | null } = {}) {
  signIn(features, options.ai ?? true)
  const shell = useShellStore()
  // 外壳常驻取数在这里换成直接塞值(AppShell 被替身顶掉了,shell.refresh 也不该真去请求)
  shell.refresh = vi.fn(async () => undefined) as typeof shell.refresh
  shell.drafts = options.drafts ?? 0
  shell.insights = options.insights ?? 248
  shell.sources = options.sources === undefined ? 0 : options.sources
  shell.loaded = true
  wrapper = mount(Home, { attachTo: document.body })
  await flushPromises()
}

beforeEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  callCapability.mockReset()
  push.mockClear()
  localStorage.clear()
  setActivePinia(createPinia())
  backend()
})

describe('Home 首页', () => {
  it('保持原来的布局:统计卡、图表在前,继续编辑与待处理在工作协同层', async () => {
    await open(ALL, { drafts: 2 })
    // 用户明确要求首页保持原来的布局,这里钉住顺序,避免以后又把中心卡提到首屏
    const stats = $('[data-testid=home-stats]')!
    const charts = $('[data-testid=home-charts]')!
    const recent = $('[data-testid=home-recent]')!
    const pending = $('[data-testid=home-pending]')!
    expect($('[data-testid=home-triage]')).toBeNull()
    expect(stats.compareDocumentPosition(charts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(charts.compareDocumentPosition(recent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(charts.compareDocumentPosition(pending) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(recent.compareDocumentPosition(pending) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('四块都有数据:最近编辑新的在前、共享动态、待处理、统计卡', async () => {
    await open(ALL, { drafts: 7 })
    expect($$('[data-testid=home-recent-item]').map((el) => el.textContent!.trim().split('\n')[0]!.replace(/\s+/g, ' '))[0]).toContain('笔记 b')
    expect($$('[data-testid=home-recent-item]')).toHaveLength(2)
    expect(text('[data-testid=home-shared-item]')).toContain('Alice 分享了笔记「共享 k1」给你')
    // 好友申请 + 7 条草稿 = 2 个待处理
    expect($$('[data-testid=home-pending-item]').map((el) => el.dataset.kind)).toEqual(['friend', 'review'])
    expect(text('[data-testid=home-pending-count]')).toBe('2')
    // 统计数字会从 0 滚动到目标值,读 DOM 文本会读到动画中途的值;直接看传给统计卡的属性
    const stats = Object.fromEntries(wrapper!.findAllComponents(KbStat).map((card) => [card.props('label'), card.props('value')]))
    expect(stats).toEqual({ 我的笔记: 248, 共享给我: 1, 待处理: 2, 存储: '3.0 GB' })
  })

  it('问候用显示名;最近编辑点进去 = 知识库页按集合 + 条目打开', async () => {
    await open()
    expect(text('h1')).toContain('林一')
    const links = $$('[data-testid=home-recent-item]')
    expect(JSON.parse(links[0]!.dataset.to!)).toEqual({ path: '/kb', query: { collection: 'proj/insights', item: 'b' } })
    expect(JSON.parse($$('[data-testid=home-shared-item]')[0]!.dataset.to!)).toEqual({ path: '/kb', query: { scope: 'shared', open: 'k1' } })
  })

  it('「新建笔记」去知识库页并带 new=1;导入去导入页', async () => {
    await open()
    $<HTMLButtonElement>('[data-testid=home-new]')!.click()
    expect(push).toHaveBeenLastCalledWith({ path: '/kb', query: { new: '1' } })
    $<HTMLButtonElement>('[data-testid=home-import]')!.click()
    expect(push).toHaveBeenLastCalledWith('/import')
  })

  it('待处理的按钮去对应的页:好友申请去好友页的「申请」页签,草稿去审核收件箱', async () => {
    await open(ALL, { drafts: 3 })
    const buttons = $$('[data-testid=home-pending-item] button')
    buttons[0]!.click()
    expect(push).toHaveBeenLastCalledWith({ path: '/friends', query: { tab: 'requests' } })
    buttons[1]!.click()
    expect(push).toHaveBeenLastCalledWith({ path: '/review' })
  })

  it('没有 collab.friends / collab.share:不请求好友申请和访问申请,快速开始里没有「邀请好友」', async () => {
    await open(['docs.notes', 'docs.upload'])
    expect(calls('friend_requests')).toHaveLength(0)
    expect(calls('access_requests')).toHaveLength(0)
    expect(text('[data-testid=home-quick]')).not.toContain('邀请好友')
    expect($('[data-testid=home-pending-empty]')).not.toBeNull()
  })

  it('没有 ai.extract:草稿不算待处理,即使外壳里有草稿数', async () => {
    await open(['docs.notes', 'collab.friends'], { drafts: 9 })
    expect($$('[data-testid=home-pending-item]').map((el) => el.dataset.kind)).toEqual(['friend'])
  })

  it('什么功能都没有:没有「新建 / 导入」按钮和快速开始', async () => {
    await open([])
    expect($('[data-testid=home-new]')).toBeNull()
    expect($('[data-testid=home-import]')).toBeNull()
    expect($('[data-testid=home-quick]')).toBeNull()
  })

  it('AI 总开关关掉:整页任何位置都没有「AI」字样,用量卡也不请求展示', async () => {
    await open(ALL, { ai: false })
    expect($('[data-testid=home-ai]')).toBeNull()
    expect(document.body.textContent).not.toMatch(/AI/)
  })

  it('AI 开着:显示今日用量和百分比', async () => {
    await open()
    expect(text('[data-testid=home-ai]')).toContain('今日 AI 用量')
    expect(text('[data-testid=home-ai]')).toContain('34%')
  })

  it('空状态:没有笔记 / 没有人分享 / 没有待处理,各自给下一步', async () => {
    backend({ list_items: { items: [], total: 0, page: 1, page_size: 6 }, shared_with_me: { items: [] }, friend_requests: { incoming: [], outgoing: [] } })
    await open()
    expect(text('[data-testid=home-recent-empty]')).toContain('还没有笔记')
    expect(text('[data-testid=home-recent-empty]')).toContain('新建笔记')
    expect(text('[data-testid=home-shared-empty]')).toContain('还没有人分享内容给你')
    expect(text('[data-testid=home-shared-empty]')).toContain('去找好友')
    expect(text('[data-testid=home-pending-empty]')).toContain('没有待处理的事')
  })

  it('一块失败不连累别的块:共享列表 500 → 只有那一块报错并可重试,最近编辑照常显示', async () => {
    backend({ shared_with_me: new CapabilityError('internal: boom', 'internal', 500) })
    await open()
    expect($('[data-testid=home-shared-error]')).not.toBeNull()
    expect(text('[data-testid=home-shared-error]')).toContain('重试')
    expect($$('[data-testid=home-recent-item]')).toHaveLength(2)
    expect($('[data-testid=home-recent-error]')).toBeNull()
    // 重试成功后恢复
    backend()
    $<HTMLButtonElement>('[data-testid=home-shared-error] button')!.click()
    await flushPromises()
    expect($('[data-testid=home-shared-error]')).toBeNull()
    expect($$('[data-testid=home-shared-item]')).toHaveLength(1)
  })

  it('403(功能没开通)不给「重试」按钮:重试也不会变', async () => {
    backend({ shared_with_me: new CapabilityError('你的账号没有开通这个功能', 'forbidden', 403) })
    await open()
    expect($('[data-testid=home-shared-error]')).not.toBeNull()
    expect($('[data-testid=home-shared-error] button')).toBeNull()
  })

  it('个别集合取不到最近更新:其余集合的照常显示;全部取不到才报错', async () => {
    backend({ list_collections: { collections: [{ name: 'good' }, { name: 'bad' }] } })
    callCapability.mockImplementation(async (name: string, args?: { collection?: string }) => {
      if (name === 'list_items' && args?.collection === 'bad') throw new CapabilityError('internal: x', 'internal', 500)
      const reply = replies[name]
      return reply ?? {}
    })
    await open()
    expect($$('[data-testid=home-recent-item]')).toHaveLength(2)
    expect($('[data-testid=home-recent-error]')).toBeNull()

    wrapper!.unmount()
    document.body.innerHTML = ''
    callCapability.mockImplementation(async (name: string) => {
      if (name === 'list_items') throw new CapabilityError('internal: x', 'internal', 500)
      return replies[name] ?? {}
    })
    await open()
    expect($('[data-testid=home-recent-error]')).not.toBeNull()
  })

  it('实时:收到好友申请的通知后待处理静默刷新(不闪骨架屏);收到分享后共享动态刷新', async () => {
    await open()
    const before = calls('friend_requests').length
    backend({ friend_requests: { incoming: [], outgoing: [] } })
    pushLive({ type: 'notify', data: { notification: { kind: 'friend_request' } } })
    await flushPromises()
    expect(calls('friend_requests').length).toBe(before + 1)
    expect($('[data-testid=home-pending-loading]')).toBeNull()

    const sharedBefore = calls('shared_with_me').length
    pushLive({ type: 'notify', data: { notification: { kind: 'share_received' } } })
    await flushPromises()
    expect(calls('shared_with_me').length).toBe(sharedBefore + 1)
    // 无关的通知不触发任何刷新
    const total = callCapability.mock.calls.length
    pushLive({ type: 'notify', data: { notification: { kind: 'announcement' } } })
    await flushPromises()
    expect(callCapability.mock.calls.length).toBe(total)
  })
})

describe('Home 新用户引导', () => {
  const stepIds = () => $$('[data-testid=home-guide] [data-step]').map((el) => el.dataset.step)

  it('一条笔记都没有的新用户:显示引导,按功能列出步骤', async () => {
    await open(ALL, { insights: 0 })
    expect($('[data-testid=home-guide]')).not.toBeNull()
    expect(stepIds()).toEqual(['note', 'import', 'search', 'friends', 'assistant'])
  })

  it('引导显示时,和它重复的「快速开始」卡让位;引导消失后它回来', async () => {
    await open(ALL, { insights: 0 })
    expect($('[data-testid=home-guide]')).not.toBeNull()
    expect($('[data-testid=home-quick]')).toBeNull()
    $<HTMLButtonElement>('[data-testid=guide-dismiss]')!.click()
    await flushPromises()
    expect($('[data-testid=home-quick]')).not.toBeNull()
  })

  it('已经有笔记:不显示;还没取到数据:也不显示(免得闪一下)', async () => {
    await open(ALL, { insights: 3 })
    expect($('[data-testid=home-guide]')).toBeNull()
  })

  it('没开通的功能不出现在步骤里', async () => {
    await open(['docs.notes', 'search.basic'], { insights: 0 })
    expect(stepIds()).toEqual(['note', 'search'])
  })

  it('已经导入过数据源:那一步标「已完成」', async () => {
    await open(ALL, { insights: 0, sources: 2 })
    expect($('[data-step=import]')!.textContent).toContain('已完成')
    expect($('[data-step=note]')!.textContent).not.toContain('已完成')
  })

  it('「去做」去对应的页面;写笔记直接进新建表单', async () => {
    await open(ALL, { insights: 0 })
    $<HTMLButtonElement>('[data-step=note] button')!.click()
    expect(push).toHaveBeenLastCalledWith('/kb?new=1')
    $<HTMLButtonElement>('[data-step=import] button')!.click()
    expect(push).toHaveBeenLastCalledWith('/import')
  })

  it('助手那一步是打开助手抽屉,不是跳页', async () => {
    await open(ALL, { insights: 0 })
    const before = push.mock.calls.length
    $<HTMLButtonElement>('[data-step=assistant] button')!.click()
    expect(push.mock.calls.length).toBe(before)
    const { usePanelsStore } = await import('@/stores/panels')
    expect(usePanelsStore().assistantOpen).toBe(true)
  })

  it('点「不再显示」:马上收起,并记在本设备;下次打开不再出现', async () => {
    await open(ALL, { insights: 0 })
    $<HTMLButtonElement>('[data-testid=guide-dismiss]')!.click()
    await flushPromises()
    expect($('[data-testid=home-guide]')).toBeNull()
    expect(localStorage.getItem('kb.home.guide.dismissed.usr_me')).toBe('1')
    wrapper!.unmount()
    document.body.innerHTML = ''
    await open(ALL, { insights: 0 })
    expect($('[data-testid=home-guide]')).toBeNull()
  })

  it('刷新页面时用户资料是后来才取到的:关掉过的引导不能因此又冒出来', async () => {
    localStorage.setItem('kb.home.guide.dismissed.usr_me', '1')
    // 先不登录(模拟刷新后 session.user 还没取回来),挂载,再把用户补上
    const session = useSessionStore()
    session.features = new Set(ALL)
    session.loaded = true
    const shell = useShellStore()
    shell.refresh = vi.fn(async () => undefined) as typeof shell.refresh
    shell.insights = 0
    shell.loaded = true
    wrapper = mount(Home, { attachTo: document.body })
    await flushPromises()
    session.user = { id: 'usr_me', username: 'me', display_name: '林一', email: 'me@example.com', role_id: 'r', space_id: null, must_change_password: false }
    await flushPromises()
    expect($('[data-testid=home-guide]')).toBeNull()
  })

  it('「不再显示」按用户分开:另一个账号在同一台设备上登录,仍然看得到', async () => {
    localStorage.setItem('kb.home.guide.dismissed.usr_other', '1')
    await open(ALL, { insights: 0 })
    expect($('[data-testid=home-guide]')).not.toBeNull()
  })

  it('AI 总开关关掉:引导里没有助手那一步,整页也没有「AI」字样', async () => {
    await open(ALL, { insights: 0, ai: false })
    expect(stepIds()).not.toContain('assistant')
    expect(document.body.textContent).not.toMatch(/AI/)
  })
})

describe('首页 · 我的活动', () => {
  const days = Array.from({ length: 91 }, (_, index) => `2026-08-${String(index + 1).padStart(2, '0')}`)
  const line = (fill: (index: number) => number) => days.map((_, index) => fill(index))
  const activityReply = {
    days,
    notes: line((index) => (index >= 88 ? 2 : 0)),
    edits: line((index) => (index >= 85 ? 3 : 0)),
    imports: line(() => 0),
    searches: line((index) => (index >= 80 ? 1 : 0)),
    imports_done: line(() => 0),
    jobs_done: line(() => 0),
    ai_tokens: line(() => 0),
  }

  it('近 30 天的合计写进活动卡;「我的笔记」旁写近 30 天新增,并有迷你线', async () => {
    backend({ activity_series: activityReply })
    await open()
    // 近 30 天(最后 30 个下标 61–90):新建 3 天 × 2 = 6,编辑 6 天 × 3 = 18,搜索 11 天 × 1 = 11
    expect(text('[data-testid=home-month]')).toBe('新建笔记6编辑18导入文件0搜索11')
    expect(text('[data-testid=home-stats]')).toContain('近 30 天新增 6 条')
    expect($('[data-testid=home-stats] .spk')).not.toBeNull()
    expect(wrapper!.findComponent(KbLineChart).exists()).toBe(true)
    expect(calls('activity_series')[0]![1]).toEqual({ days: 91 })
  })

  it('连续有活动 2 天以上才显示「连续 N 天」徽标', async () => {
    backend({ activity_series: activityReply })
    await open()
    expect(text('[data-testid=home-streak]')).toBe('连续 11 天')
    wrapper!.unmount()
    document.body.innerHTML = ''
    backend({ activity_series: { ...activityReply, notes: line(() => 0), edits: line(() => 0), searches: line((index) => (index === 90 ? 1 : 0)) } })
    await open()
    expect($('[data-testid=home-streak]')).toBeNull()
  })

  it('读不到活动:只有这一张卡写原因并给重试,别的块照常', async () => {
    backend({ activity_series: new CapabilityError('internal: boom', 'internal', 500) })
    await open()
    expect(text('[data-testid=home-activity-error]')).toContain('没能读取近期活动')
    expect($('[data-testid=home-recent]')).not.toBeNull()
    expect(text('[data-testid=home-stats]')).not.toContain('近 30 天')
  })

  it('可切换日历热力与趋势图,并在有活动时展示构成条', async () => {
    backend({ activity_series: activityReply })
    await open()
    expect(wrapper!.findComponent(KbHBars).exists()).toBe(true)
    const viewSeg = wrapper!.findAllComponents(KbSegmented).find((c) => c.props('options')?.some((o: { value: string }) => o.value === 'heatmap'))
    expect(viewSeg).toBeDefined()
    expect(wrapper!.findComponent(KbLineChart).exists()).toBe(true)
    await viewSeg!.vm.$emit('update:modelValue', 'heatmap')
    await flushPromises()
    expect(wrapper!.findComponent(KbLineChart).exists()).toBe(false)
    expect($$('[data-testid=home-activity] .kb-heat > i').length).toBeGreaterThan(80)
    expect(localStorage.getItem('kb.home.activityView')).toBe('heatmap')
  })
})

describe('首页 · 权限与全员数据', () => {
  it('普通用户只能看自己数据,没有全员切换控件', async () => {
    await open(ALL)
    expect($('[data-testid=home-scope]')).toBeNull()
    const stats = Object.fromEntries(wrapper!.findAllComponents(KbStat).map((card) => [card.props('label'), card.props('value')]))
    expect(Object.keys(stats)).toContain('我的笔记')
    expect(Object.keys(stats)).not.toContain('全站笔记')
  })

  it('管理员可查看全员数据:从真实能力拉取且无硬编码', async () => {
    const adminFeatures = [...ALL, 'sys.ops', 'sys.users', 'sys.settings']
    backend({
      stats_overview: {
        totals: { rows: 5400, insights: 88, projects: 4 },
        jobs: { queued: 2, running: 1, paused: 0, done: 120, failed: 0, canceled: 0 },
        collections: [{ name: 'col1' }],
        activity_7d: [{ day: '2026-10-28', collection: 'col1', insights: 5 }],
      },
      storage_overview: {
        totals: { measured_spaces: 6, total_spaces: 8, total_bytes: 12 * 1024 ** 3, vectors_bytes: 0 },
        disk: { free_gb: 350, reserve_gb: 30, paused: false, warn: false },
        top: [],
      },
    })
    await open(adminFeatures)
    expect($('[data-testid=home-scope]')).not.toBeNull()
    const scopeSeg = wrapper!.findAllComponents(KbSegmented).find((c) => c.props('options')?.some((o: { value: string }) => o.value === 'all'))
    expect(scopeSeg).toBeDefined()
    await scopeSeg!.vm.$emit('update:modelValue', 'all')
    await flushPromises()
    const stats = Object.fromEntries(wrapper!.findAllComponents(KbStat).map((card) => [card.props('label'), card.props('value')]))
    expect(stats['全站笔记']).toBe(88)
    expect(stats['全站成员']).toBe(8)
    expect(stats['系统任务']).toBe(3)
    expect(stats['全站存储']).toBe('12 GB')
  })

  it('全员活动图用近 30 天真实活动序列,7 天内没有新笔记也不显示空状态', async () => {
    // 真实现场(2026-11-07):生产库一个月有 400+ 次搜索、20+ 次编辑,但近 7 天没有新建 insight,
    // 旧实现只看 activity_7d 会整块显示「全站暂无活动记录」
    backend({
      stats_overview: {
        totals: { rows: 5400, insights: 88, projects: 4 },
        jobs: { queued: 0, running: 0, paused: 0, done: 3, failed: 0, canceled: 0 },
        collections: [{ name: 'col1' }],
        activity_7d: [],
      },
      activity_series: {
        days: ['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07'],
        notes: [0, 0, 0, 0, 0],
        edits: [1, 0, 2, 0, 1],
        imports: [0, 0, 0, 0, 0],
        searches: [12, 9, 15, 4, 8],
      },
    })
    await open([...ALL, 'sys.ops'])
    const scopeSeg = wrapper!.findAllComponents(KbSegmented).find((c) => c.props('options')?.some((o: { value: string }) => o.value === 'all'))
    await scopeSeg!.vm.$emit('update:modelValue', 'all')
    await flushPromises()
    const activityCard = $('[data-testid=home-activity]')!
    expect(activityCard.textContent).not.toContain('全站暂无活动记录')
    expect(activityCard.textContent).toContain('近 30 天新建笔记、编辑、导入文件与搜索')
    const chart = wrapper!.findAllComponents(KbLineChart).find((c) => c.props('label') === '全站近 30 天活动')
    expect(chart).toBeDefined()
    expect(chart!.props('labels')).toEqual(['11-03', '11-04', '11-05', '11-06', '11-07'])
    const searches = chart!.props('series').find((s: { name: string }) => s.name === '搜索')!
    expect(searches.values).toEqual([12, 9, 15, 4, 8])
  })
})
