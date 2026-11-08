// 顶栏:AI 按钮只在有功能点时出现、通知角标、侧栏开关只在有侧栏时出现。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

let currentPath = '/eval'
const push = vi.fn()
vi.mock('vue-router', () => ({
  useRoute: () => ({ path: currentPath, fullPath: currentPath, query: {}, meta: {} }),
  useRouter: () => ({ push }),
  RouterLink: { name: 'RouterLink', props: ['to'], template: '<a><slot /></a>' },
}))
vi.mock('@/api/prefs', () => ({ fetchPrefs: vi.fn(async () => ({})), savePrefs: vi.fn(async () => true) }))
vi.mock('@/api/client', () => ({ callCapability: vi.fn(async () => ({})) }))

import ShellTopbar from './ShellTopbar.vue'
import { useSessionStore } from '@/stores/session'
import { usePanelsStore } from '@/stores/panels'
import { useNotificationsStore } from '@/stores/notifications'
import { useNavStore } from '@/stores/nav'
import { remeasureViewport } from '@/composables/useViewport'

function at(width: number, height = 900) {
  vi.stubGlobal('innerWidth', width)
  vi.stubGlobal('innerHeight', height)
  remeasureViewport()
}
function signIn(features: string[]) {
  const session = useSessionStore()
  session.user = { id: 'u1', username: 'alice', display_name: 'Alice', email: null, role_id: 'r', space_id: null, must_change_password: false }
  session.features = new Set(features)
  session.loaded = true
}
const mountBar = (alerts: { id: 'offline' | 'backup' | 'disk'; text: string }[] = []) =>
  mount(ShellTopbar, { props: { alerts, showShortcuts: true }, global: { stubs: { Teleport: true } } })

beforeEach(() => {
  localStorage.clear()
  currentPath = '/eval'
  push.mockClear()
  setActivePinia(createPinia())
  at(1440)
})

describe('ShellTopbar', () => {
  it('有 ai.assistant 才有 AI 按钮,没有就整个不渲染(AI 总开关关掉后隐藏)', () => {
    signIn(['ai.assistant'])
    expect(mountBar().find('[data-feature="ai.assistant"]').exists()).toBe(true)
    setActivePinia(createPinia())
    signIn(['docs.notes'])
    expect(mountBar().find('[data-feature="ai.assistant"]').exists()).toBe(false)
  })

  it('点 AI 按钮开合助手抽屉', async () => {
    signIn(['ai.assistant'])
    const panels = usePanelsStore()
    const bar = mountBar()
    await bar.find('[data-testid="assistant-toggle"]').trigger('click')
    expect(panels.assistantOpen).toBe(true)
    expect(bar.find('[data-testid="assistant-toggle"]').attributes('aria-expanded')).toBe('true')
    await bar.find('[data-testid="assistant-toggle"]').trigger('click')
    expect(panels.assistantOpen).toBe(false)
  })

  it('助手正在回答时按钮上有脉动点', async () => {
    signIn(['ai.assistant'])
    const panels = usePanelsStore()
    const bar = mountBar()
    expect(bar.find('.kb-pulse-dot').exists()).toBe(false)
    panels.assistantBusy = true
    await bar.vm.$nextTick()
    expect(bar.find('.kb-pulse-dot').exists()).toBe(true)
  })

  it('通知角标:0 不显示,有未读显示数字,超过 99 显示 99+,aria-label 带数量', async () => {
    signIn([])
    const notifications = useNotificationsStore()
    const bar = mountBar()
    expect(bar.find('[data-testid="bell-badge"]').exists()).toBe(false)
    notifications.unread = 7
    await bar.vm.$nextTick()
    expect(bar.find('[data-testid="bell-badge"]').text()).toBe('7')
    expect(bar.find('[data-testid="bell"]').attributes('aria-label')).toBe('通知,7 条未读')
    notifications.unread = 100
    await bar.vm.$nextTick()
    expect(bar.find('[data-testid="bell-badge"]').text()).toBe('99+')
  })

  it('点铃铛打开通知抽屉', async () => {
    signIn([])
    const panels = usePanelsStore()
    const bar = mountBar()
    await bar.find('[data-testid="bell"]').trigger('click')
    expect(panels.notificationsOpen).toBe(true)
  })

  it('侧栏开关:电脑上有,点它在展开和图标栏之间切换;手机上没有', async () => {
    signIn([])
    const nav = useNavStore()
    const bar = mountBar()
    expect(nav.state).toBe('expanded')
    await bar.find('[data-testid="nav-toggle"]').trigger('click')
    expect(nav.state).toBe('rail')
    at(390, 844)
    setActivePinia(createPinia())
    expect(mountBar().find('[data-testid="nav-toggle"]').exists()).toBe(false)
  })

  it('搜索按钮发出 search;顶栏里没有「刷新」「退出」', async () => {
    signIn([])
    const bar = mountBar()
    await bar.find('[data-testid="topbar-search"]').trigger('click')
    expect(bar.emitted('search')).toHaveLength(1)
    expect(bar.text()).not.toContain('刷新')
    expect(bar.text()).not.toContain('退出')
  })

  it('搜索按钮的可访问名称包含屏幕上的可见文字「搜索或跳转」和快捷键提示(WCAG 2.5.3)', () => {
    signIn([])
    const bar = mountBar()
    const button = bar.find('[data-testid="topbar-search"]')
    // axe 的比法:两边抹掉空白和标点再做包含判断;窄屏文字和提示被样式隐藏,只剩图标,名称仍然在
    const squash = (text: string) => text.replace(/[\s\p{P}]/gu, '')
    const name = button.attributes('aria-label') ?? ''
    expect(squash(name)).toContain(squash(button.text()))
    expect(name).toContain('搜索或跳转')
  })

  it('页面操作 / 标题的挂载点还在(各页面的 <AppShell> 会把内容传送进来)', () => {
    signIn([])
    const bar = mountBar()
    expect(bar.find('#kb-slot-bc').exists()).toBe(true)
    expect(bar.find('#kb-slot-actions').exists()).toBe(true)
  })

  it('手机(标签栏形态):从「我的」进入的页面左上角有返回键,点它回「我的」;标签栏里的页面没有', async () => {
    at(390, 844)
    signIn([])
    currentPath = '/tasks'
    const bar = mountBar()
    await bar.find('[data-testid="topbar-back"]').trigger('click')
    expect(push).toHaveBeenCalledWith('/mine')
    setActivePinia(createPinia())
    signIn([])
    currentPath = '/search'
    expect(mountBar().find('[data-testid="topbar-back"]').exists()).toBe(false)
  })

  it('电脑上没有返回键(有侧栏和面包屑)', () => {
    signIn([])
    currentPath = '/tasks'
    expect(mountBar().find('[data-testid="topbar-back"]').exists()).toBe(false)
  })

  it('手机标题的挂载点存在(各页面的标题传送到这里)', () => {
    at(390, 844)
    signIn([])
    expect(mountBar().find('#kb-slot-mbar').exists()).toBe(true)
  })
})
