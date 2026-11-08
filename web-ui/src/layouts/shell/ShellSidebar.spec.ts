// 侧栏组件:三态渲染、浮层、键盘调整宽度、找回把手。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/search', fullPath: '/search', query: {}, meta: {} }),
  RouterLink: { name: 'RouterLink', props: ['to'], template: '<a class="router-link" :href="typeof to === \'string\' ? to : to.path"><slot /></a>' },
}))
vi.mock('@/api/prefs', () => ({ fetchPrefs: vi.fn(async () => ({})), savePrefs: vi.fn(async () => true) }))

import ShellSidebar from './ShellSidebar.vue'
import { useNavStore } from '@/stores/nav'
import { useUiStore } from '@/stores/ui'
import { remeasureViewport } from '@/composables/useViewport'
import type { NavGroup } from './types'

const groups: NavGroup[] = [
  { id: 'mine', label: '我的', items: [
    { id: 'home', to: '/home', icon: 'home', label: '首页' },
    { id: 'search', to: '/search', icon: 'search', label: '搜索', active: true },
    { id: 'review', to: '/review', icon: 'inbox', label: '审核收件箱', count: 7 },
  ] },
  { id: 'admin', label: '管理', collapsible: true, items: [{ id: 'users', to: '/users', icon: 'shield', label: '用户与权限' }] },
]

/**
 * 可访问名称必须包含屏幕上看得见的文字(WCAG 2.5.3,axe label-content-name-mismatch)。
 * axe 的比法:两边都抹掉空白和标点再做包含判断,可见文字取元素里所有文字(aria-hidden 的快捷键提示 / 角标也算看得见)。
 */
const squash = (text: string) => text.replace(/[\s\p{P}]/gu, '')
function expectNameHasVisibleText(el: Element) {
  const name = el.getAttribute('aria-label') ?? el.textContent ?? ''
  expect(squash(name), `名称「${name}」应包含可见文字「${el.textContent}」`).toContain(squash(el.textContent ?? ''))
}

function at(width: number, height = 900) {
  vi.stubGlobal('innerWidth', width)
  vi.stubGlobal('innerHeight', height)
  remeasureViewport()
}
const mountSidebar = () => mount(ShellSidebar, { props: { groups }, attachTo: document.body })

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = ''
  setActivePinia(createPinia())
  at(1440)
})

describe('ShellSidebar', () => {
  it('展开:显示分组标题、文字、角标,当前项有 aria-current', () => {
    const wrapper = mountSidebar()
    expect(wrapper.find('.kb-nav').classes()).not.toContain('is-rail')
    expect(wrapper.text()).toContain('我的')
    expect(wrapper.text()).toContain('管理')
    expect(wrapper.text()).toContain('审核收件箱')
    expect(wrapper.find('.kb-nav-badge').text()).toBe('7')
    expect(wrapper.find('[aria-current="page"]').text()).toContain('搜索')
    wrapper.unmount()
  })

  it('图标栏:是 is-rail,图标按钮带 title 和 aria-label(没有文字也读得出来)', async () => {
    const nav = useNavStore()
    const wrapper = mountSidebar()
    nav.cycle()
    await flushPromises()
    expect(wrapper.find('.kb-nav').classes()).toContain('is-rail')
    const item = wrapper.find('[data-nav-id="review"]')
    // 图标栏里角标只剩一个小红点,数字只能靠名称读出来
    expect(item.attributes('aria-label')).toBe('审核收件箱 7 项待处理')
    expect(item.attributes('title')).toBe('审核收件箱')
    // 没有数字的项:名称就是文字本身
    expect(wrapper.find('[data-nav-id="home"]').attributes('aria-label')).toBe('首页')
    expect(wrapper.find('[data-testid="nav-collapse"]').attributes('aria-label')).toBe('展开侧栏')
    wrapper.unmount()
  })

  it('展开:带角标的项由链接统一给名称「文字 + 待处理数」,角标自己不带 aria-label,且名称含可见文字', () => {
    const wrapper = mountSidebar()
    const item = wrapper.find('[data-nav-id="review"]')
    expect(item.attributes('aria-label')).toBe('审核收件箱 7 项待处理')
    // 角标若自带 aria-label,链接名称会被拼成「…7 项待处理」而屏幕上只有「…7」,可见文字对不上
    expect(wrapper.find('.kb-nav-badge').attributes('aria-label')).toBeUndefined()
    expect(wrapper.find('.kb-nav-badge').attributes('aria-hidden')).toBe('true')
    // 没有数字的项不写多余的 aria-label,名称直接来自可见文字
    expect(wrapper.find('[data-nav-id="home"]').attributes('aria-label')).toBeUndefined()
    wrapper.unmount()
  })

  it('展开:侧栏里每个按钮 / 链接的可访问名称都包含它的可见文字(含搜索框、收起按钮上的快捷键提示)', () => {
    const wrapper = mountSidebar()
    const items = wrapper.findAll('.kb-nav-item')
    expect(items.length).toBeGreaterThanOrEqual(5) // 4 个入口 + 收起
    for (const item of items) expectNameHasVisibleText(item.element)
    // 搜索框和收起按钮的可见文字里带着 ⌘K / ⌘B,它们不能再用 aria-label 把快捷键提示丢掉
    expect(wrapper.find('[data-testid="nav-collapse"]').attributes('aria-label')).toBeUndefined()
    wrapper.unmount()
  })

  it('隐藏:侧栏 inert + aria-hidden,出现找回把手,点它展开', async () => {
    const nav = useNavStore()
    const wrapper = mountSidebar()
    nav.cycle()
    nav.cycle()
    await flushPromises()
    expect(nav.state).toBe('hidden')
    const aside = wrapper.find('aside.kb-nav')
    expect(aside.attributes('aria-hidden')).toBe('true')
    expect(aside.attributes('inert')).toBeDefined()
    const reveal = wrapper.find('[data-testid="nav-reveal"]')
    expect(reveal.exists()).toBe(true)
    await reveal.trigger('click')
    expect(nav.state).toBe('expanded')
    expect(wrapper.find('[data-testid="nav-reveal"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('手机(标签栏形态)不渲染侧栏', () => {
    at(390, 844)
    const wrapper = mountSidebar()
    expect(wrapper.find('.kb-nav').exists()).toBe(false)
    wrapper.unmount()
  })

  it('平板:默认图标栏,点底部按钮开浮层(显示文字、有遮罩),点遮罩收回', async () => {
    at(1000, 1300)
    const nav = useNavStore()
    const wrapper = mountSidebar()
    expect(wrapper.find('.kb-nav').classes()).toContain('is-rail')
    expect(wrapper.find('[data-testid="nav-resizer"]').exists()).toBe(false)
    await wrapper.find('[data-testid="nav-collapse"]').trigger('click')
    expect(nav.overlayOpen).toBe(true)
    expect(wrapper.find('.kb-nav').classes()).toContain('is-overlay')
    expect(wrapper.find('.kb-nav').classes()).not.toContain('is-rail')
    await wrapper.find('.kb-nav-scrim').trigger('click')
    expect(nav.overlayOpen).toBe(false)
    wrapper.unmount()
  })

  it('平板:Esc 收回浮层', async () => {
    at(1000, 1300)
    const nav = useNavStore()
    const wrapper = mountSidebar()
    nav.toggle()
    expect(nav.overlayOpen).toBe(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(nav.overlayOpen).toBe(false)
    wrapper.unmount()
  })

  it('拖动边缘可用键盘代替:→ 加宽 16,← 变窄,Enter 在展开和图标栏之间切换', async () => {
    const ui = useUiStore()
    const nav = useNavStore()
    const wrapper = mountSidebar()
    const handle = wrapper.find('[data-testid="nav-resizer"]')
    expect(handle.attributes('role')).toBe('separator')
    expect(handle.attributes('tabindex')).toBe('0')
    await handle.trigger('keydown', { key: 'ArrowRight' })
    expect(ui.sidebarWidth).toBe(256)
    await handle.trigger('keydown', { key: 'ArrowLeft' })
    await handle.trigger('keydown', { key: 'ArrowLeft' })
    expect(ui.sidebarWidth).toBe(224)
    await handle.trigger('keydown', { key: 'Enter' })
    expect(nav.state).toBe('rail')
    await handle.trigger('keydown', { key: 'ArrowRight' })
    expect(nav.state).toBe('expanded')
    wrapper.unmount()
  })

  it('侧栏不再包含搜索框(已由顶栏统一承载)', () => {
    const wrapper = mountSidebar()
    expect(wrapper.find('.kb-nav-search').exists()).toBe(false)
    wrapper.unmount()
  })

  it('「管理」可以折叠:收起来后入口消失、开关说清楚状态,选择记进偏好', async () => {
    const ui = useUiStore()
    const wrapper = mountSidebar()
    const toggle = () => wrapper.find('[data-testid="nav-group-toggle"]')
    expect(toggle().attributes('aria-expanded')).toBe('true')
    expect(toggle().text()).toContain('管理')
    expect(wrapper.find('[data-nav-id="users"]').exists()).toBe(true)

    await toggle().trigger('click')
    expect(toggle().attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('[data-nav-id="users"]').exists()).toBe(false)
    // 收起的是「管理」，上面的入口一个不少
    expect(wrapper.find('[data-nav-id="search"]').exists()).toBe(true)
    // 显式选择存进偏好（换设备也记得，且不再让侧栏自动猜）
    expect(ui.navCollapsed).toEqual(['admin'])
    expect(JSON.parse(localStorage.getItem('kb.ui') || '{}').navCollapsed).toEqual(['admin'])

    await toggle().trigger('click')
    expect(toggle().attributes('aria-expanded')).toBe('true')
    expect(wrapper.find('[data-nav-id="users"]').exists()).toBe(true)
    // 手动展开过也要记住：空数组 = 「就是要展开」，否则下次窗口一变矮又给你收起来
    expect(ui.navCollapsed).toEqual([])
    wrapper.unmount()
  })

  it('图标栏里不折叠:没有分组标题，收了就一个管理入口都点不到', async () => {
    const nav = useNavStore()
    const ui = useUiStore()
    const wrapper = mountSidebar()
    ui.setNavCollapsed(['admin'])
    nav.cycle()
    await flushPromises()
    expect(wrapper.find('.kb-nav').classes()).toContain('is-rail')
    expect(wrapper.find('[data-testid="nav-group-toggle"]').exists()).toBe(false)
    expect(wrapper.find('[data-nav-id="users"]').exists()).toBe(true)
    wrapper.unmount()
  })
})
