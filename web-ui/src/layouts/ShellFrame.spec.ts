// ShellFrame:手机底部标签栏(取代旧的汉堡抽屉)、电脑侧栏、通知抽屉。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const replace = vi.fn()
const push = vi.fn()
let currentPath = '/admin/overview'
vi.mock('vue-router', () => ({
  useRoute: () => ({ path: currentPath, fullPath: currentPath, query: {}, meta: {} }),
  useRouter: () => ({ replace, push }),
  RouterLink: {
    name: 'RouterLink',
    props: ['to'],
    template: '<a :href="typeof to === \'string\' ? to : to.path" class="router-link"><slot /></a>',
  },
}))

vi.mock('@/api/client', () => ({
  callCapability: vi.fn(async (name: string) => {
    if (name === 'list_projects') return { projects: [] }
    if (name === 'list_sources') return { sources: [] }
    if (name === 'backup_state') return { alert: null }
    if (name === 'notification_list') return { notifications: [], unread: 3, next_before_id: null }
    return {}
  }),
  health: vi.fn(async () => ({ ok: true, version: '0.4.0' })),
}))
vi.mock('@/api/prefs', () => ({ fetchPrefs: vi.fn(async () => ({})), savePrefs: vi.fn(async () => true) }))
vi.mock('@/composables/useLiveEvents', () => ({ useLiveEvents: vi.fn(), subscribeLive: vi.fn() }))

import ShellFrame from './ShellFrame.vue'
import { remeasureViewport } from '@/composables/useViewport'
import { usePanelsStore } from '@/stores/panels'

function at(width: number, height = 900) {
  vi.stubGlobal('innerWidth', width)
  vi.stubGlobal('innerHeight', height)
  remeasureViewport()
}

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = ''
  currentPath = '/admin/overview'
  setActivePinia(createPinia())
  replace.mockClear()
  push.mockClear()
})

describe('ShellFrame 手机', () => {
  it('底部标签栏:首页、知识库、搜索、通知、我的;没有汉堡按钮、抽屉和悬浮球', async () => {
    at(390, 844)
    const wrapper = mount(ShellFrame, { attachTo: document.body, slots: { default: '<div class="test-content">内容</div>' } })
    await flushPromises()
    const tabs = wrapper.findAll('.kb-tabbar .kb-tab')
    expect(tabs.map((tab) => tab.text().replace(/\d+/g, '').trim())).toEqual(['首页', '知识库', '搜索', '通知', '我的'])
    expect(wrapper.find('button.hamb').exists()).toBe(false)
    expect(wrapper.find('.kb-mobile-nav-wrap').exists()).toBe(false)
    expect(wrapper.find('.kb-fab').exists()).toBe(false)
    expect(wrapper.find('.kb-nav').exists()).toBe(false)
    expect(wrapper.find('.test-content').exists()).toBe(true)
    wrapper.unmount()
  })

  it('标签指向正确的页面;当前页不属于前三个标签时高亮「我的」', async () => {
    at(390, 844)
    const wrapper = mount(ShellFrame, { attachTo: document.body })
    await flushPromises()
    expect(wrapper.find('[data-tab="home"]').attributes('href')).toBe('/home')
    expect(wrapper.find('[data-tab="kb"]').attributes('href')).toBe('/kb')
    expect(wrapper.find('[data-tab="search"]').attributes('href')).toBe('/search')
    expect(wrapper.find('[data-tab="mine"]').attributes('href')).toBe('/mine')
    // 当前路径是 /admin/overview(管理页,从「我的」进入)→ 「我的」高亮
    expect(wrapper.find('[data-tab="mine"]').classes()).toContain('on')
    expect(wrapper.find('[data-tab="home"]').classes()).not.toContain('on')
    wrapper.unmount()
  })

  it('点「通知」标签打开通知抽屉,角标是未读数;再点收起', async () => {
    at(390, 844)
    const panels = usePanelsStore()
    const wrapper = mount(ShellFrame, { attachTo: document.body })
    await flushPromises()
    expect(wrapper.find('[data-testid="tab-badge-notify"]').text()).toBe('3')
    await wrapper.find('[data-tab="notify"]').trigger('click')
    await flushPromises()
    expect(panels.notificationsOpen).toBe(true)
    expect(document.body.querySelector('[data-testid="notification-drawer"]')).not.toBeNull()
    // 通知标签高亮,「我的」不再高亮
    expect(wrapper.find('[data-tab="notify"]').classes()).toContain('on')
    expect(wrapper.find('[data-tab="mine"]').classes()).not.toContain('on')
    await wrapper.find('[data-tab="notify"]').trigger('click')
    await flushPromises()
    expect(panels.notificationsOpen).toBe(false)
    wrapper.unmount()
  })

  it('没有 search.basic 功能点的账号看不到「搜索」标签', async () => {
    at(390, 844)
    const { useSessionStore } = await import('@/stores/session')
    const session = useSessionStore()
    session.features = new Set(['docs.notes'])
    session.loaded = true
    const wrapper = mount(ShellFrame, { attachTo: document.body })
    await flushPromises()
    expect(wrapper.find('[data-tab="search"]').exists()).toBe(false)
    expect(wrapper.findAll('.kb-tabbar .kb-tab')).toHaveLength(4)
    wrapper.unmount()
  })
})

describe('ShellFrame 平板与电脑', () => {
  it('电脑:有侧栏和顶栏,没有标签栏', async () => {
    at(1440, 900)
    const wrapper = mount(ShellFrame, { attachTo: document.body })
    await flushPromises()
    expect(wrapper.find('.kb-nav').exists()).toBe(true)
    expect(wrapper.find('.kb-topbar').exists()).toBe(true)
    expect(wrapper.find('.kb-tabbar').exists()).toBe(false)
    wrapper.unmount()
  })

  it('横屏的小屏(600–839 宽)用图标栏而不是标签栏', async () => {
    at(700, 400)
    const wrapper = mount(ShellFrame, { attachTo: document.body })
    await flushPromises()
    expect(wrapper.find('.kb-tabbar').exists()).toBe(false)
    expect(wrapper.find('.kb-nav').exists()).toBe(true)
    wrapper.unmount()
  })

  it('竖屏的折叠屏 / 小平板(600–839)用标签栏', async () => {
    at(700, 1000)
    const wrapper = mount(ShellFrame, { attachTo: document.body })
    await flushPromises()
    expect(wrapper.find('.kb-tabbar').exists()).toBe(true)
    expect(wrapper.find('.kb-nav').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('ShellFrame 键盘:跳到主要内容', () => {
  it('第一个可聚焦的东西就是「跳到主要内容」,在侧栏所有入口之前', async () => {
    at(1440, 900)
    const wrapper = mount(ShellFrame, { attachTo: document.body, slots: { default: '<div class="test-content">内容</div>' } })
    await flushPromises()
    const first = document.body.querySelector<HTMLElement>('a[href], button, input, [tabindex]:not([tabindex="-1"])')!
    expect(first.classList.contains('kb-skip-link')).toBe(true)
    expect(first.textContent).toBe('跳到主要内容')
    wrapper.unmount()
  })

  it('点它(或在它上面按 Enter)把焦点放到内容区,不改地址栏的 hash(history 路由会把 hash 当成路由变化)', async () => {
    at(1440, 900)
    const wrapper = mount(ShellFrame, { attachTo: document.body, slots: { default: '<div class="test-content">内容</div>' } })
    await flushPromises()
    const main = document.getElementById('kb-main')!
    expect(main.getAttribute('tabindex')).toBe('-1')
    expect(main.querySelector('.test-content')).not.toBeNull()
    // 默认的锚点跳转必须被拦掉(否则地址栏多出 #kb-main,history 路由当成一次路由变化)
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    wrapper.find('[data-testid=skip-link]').element.dispatchEvent(click)
    expect(click.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(main)
    wrapper.unmount()
  })

  it('手机也有(外接键盘的平板 / 手机同样用得上)', async () => {
    at(390, 844)
    const wrapper = mount(ShellFrame, { attachTo: document.body })
    await flushPromises()
    expect(wrapper.find('[data-testid=skip-link]').exists()).toBe(true)
    wrapper.unmount()
  })
})


describe('ShellFrame 刷新节奏(卡 A)', () => {
  it('页面隐藏时外壳不轮询;回到前台立刻刷新一次', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    let visibility: DocumentVisibilityState = 'visible'
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
    const { callCapability } = await import('@/api/client')
    const statsCalls = () => vi.mocked(callCapability).mock.calls.filter((call) => call[0] === 'stats_overview').length
    at(1440)
    const wrapper = mount(ShellFrame, { attachTo: document.body })
    await flushPromises()
    const first = statsCalls()
    expect(first).toBeGreaterThanOrEqual(1)
    visibility = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(statsCalls()).toBe(first)
    visibility = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    await flushPromises()
    expect(statsCalls()).toBe(first + 1)
    wrapper.unmount()
    vi.useRealTimers()
  })
})
