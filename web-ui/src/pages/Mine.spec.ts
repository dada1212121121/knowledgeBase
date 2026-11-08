// 「我的」页:账号卡片、按功能表过滤的入口、AI 助手(受功能点控制)、退出登录。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const logout = vi.fn(async () => undefined)
vi.mock('@/api/client', () => ({
  logout: () => logout(),
  callCapability: vi.fn(async () => ({})),
  health: vi.fn(async () => ({})),
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/mine', query: {}, meta: {} }),
  useRouter: () => ({ push: vi.fn() }),
  RouterLink: { name: 'RouterLink', props: ['to'], template: '<a class="router-link" :href="to"><slot /></a>' },
}))
// 页面框架只负责把标题 / 操作传送进顶栏,与这里要测的无关
vi.mock('@/layouts/AppShell.vue', () => ({ default: { template: '<div class="app-shell"><slot /></div>' } }))

import Mine from './Mine.vue'
import { useSessionStore } from '@/stores/session'
import { usePanelsStore } from '@/stores/panels'

function signIn(features: string[]) {
  const session = useSessionStore()
  session.user = { id: 'u1', username: 'alice', display_name: 'Alice', email: 'alice@example.com', role_id: 'r', space_id: null, must_change_password: false }
  session.features = new Set(features)
  session.loaded = true
}

beforeEach(() => {
  setActivePinia(createPinia())
  logout.mockClear()
})

describe('Mine', () => {
  it('账号卡片显示名字和邮箱,点它去个人设置', () => {
    signIn([])
    const wrapper = mount(Mine)
    const profile = wrapper.find('[data-testid="mine-profile"]')
    expect(profile.text()).toContain('Alice')
    expect(profile.text()).toContain('alice@example.com')
    expect(profile.attributes('href')).toBe('/me')
  })

  it('标签栏里已有的入口(首页 / 知识库 / 搜索)不重复列出;其余按功能表出现', () => {
    signIn(['ai.extract', 'docs.upload'])
    const wrapper = mount(Mine)
    const ids = wrapper.findAll('[data-nav-id]').map((row) => row.attributes('data-nav-id'))
    expect(ids).not.toContain('kb')
    expect(ids).not.toContain('search')
    expect(ids).toContain('review')
    expect(ids).toContain('tasks')
    expect(ids).not.toContain('eval') // 没有 search.tune
    expect(ids).not.toContain('users') // 没有 sys.users
  })

  it('AI 助手入口受 ai.assistant 控制;点它打开助手抽屉', async () => {
    signIn([])
    expect(mount(Mine).find('[data-testid="mine-assistant"]').exists()).toBe(false)
    setActivePinia(createPinia())
    signIn(['ai.assistant'])
    const panels = usePanelsStore()
    const wrapper = mount(Mine)
    await wrapper.find('[data-testid="mine-assistant"]').trigger('click')
    expect(panels.assistantOpen).toBe(true)
  })

  it('退出登录:请求 logout,会话失效时也照样回登录页', async () => {
    signIn([])
    const assign = vi.fn()
    vi.stubGlobal('location', { ...window.location, set href(value: string) { assign(value) } })
    const wrapper = mount(Mine)
    logout.mockRejectedValueOnce(new Error('401'))
    await wrapper.find('[data-testid="mine-signout"]').trigger('click')
    await flushPromises()
    expect(logout).toHaveBeenCalledTimes(1)
    expect(assign).toHaveBeenCalledWith('/login')
    vi.unstubAllGlobals()
  })
})
