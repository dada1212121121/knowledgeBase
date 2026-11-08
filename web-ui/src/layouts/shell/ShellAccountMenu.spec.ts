// 头像菜单:内容、键盘操作、告警圆点、退出。菜单被 Teleport 到 body,所以从 document 里找。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('vue-router', () => ({
  RouterLink: { name: 'RouterLink', props: ['to'], template: '<a class="router-link" href="#" v-bind="$attrs"><slot /></a>' },
}))

import ShellAccountMenu from './ShellAccountMenu.vue'
import { useSessionStore } from '@/stores/session'

function signIn(features: string[]) {
  const session = useSessionStore()
  session.user = { id: 'u1', username: 'alice', display_name: 'Alice', email: 'alice@example.com', role_id: 'r', space_id: null, must_change_password: false }
  session.features = new Set(features)
  session.loaded = true
}
const menuEl = () => document.querySelector<HTMLElement>('[data-testid="account-menu"]')
const mountMenu = (alerts: { id: 'offline' | 'backup' | 'disk'; text: string }[] = [], showShortcuts = true) =>
  mount(ShellAccountMenu, { props: { alerts, showShortcuts }, attachTo: document.body })

beforeEach(() => {
  document.body.innerHTML = ''
  setActivePinia(createPinia())
})

describe('ShellAccountMenu', () => {
  it('没登录什么都不渲染', () => {
    expect(mountMenu().find('[data-testid="account-trigger"]').exists()).toBe(false)
  })

  it('点头像展开:显示名字 / 邮箱和固定几项;退出登录是危险色', async () => {
    signIn(['docs.notes'])
    const wrapper = mountMenu()
    await wrapper.find('[data-testid="account-trigger"]').trigger('click')
    await flushPromises()
    const text = menuEl()!.textContent!
    for (const word of ['Alice', 'alice@example.com', '个人设置', '外观', '快捷键', '退出登录']) expect(text).toContain(word)
    expect(text).not.toContain('系统状态')
    expect(menuEl()!.querySelector('[data-testid="signout"]')!.classList.contains('is-danger')).toBe(true)
    expect(wrapper.find('[data-testid="account-trigger"]').attributes('aria-expanded')).toBe('true')
    wrapper.unmount()
  })

  it('有 sys.ops 才有「系统状态」', async () => {
    signIn(['sys.ops'])
    const wrapper = mountMenu()
    await wrapper.find('[data-testid="account-trigger"]').trigger('click')
    await flushPromises()
    expect(menuEl()!.textContent).toContain('系统状态')
    wrapper.unmount()
  })

  it('手机上不显示「快捷键」', async () => {
    signIn([])
    const wrapper = mountMenu([], false)
    await wrapper.find('[data-testid="account-trigger"]').trigger('click')
    await flushPromises()
    expect(menuEl()!.textContent).not.toContain('快捷键')
    wrapper.unmount()
  })

  it('告警:头像上有圆点,aria-label 说明,菜单里列出原因', async () => {
    signIn(['sys.ops'])
    const wrapper = mountMenu([{ id: 'disk', text: '磁盘已用 95%,快满了' }])
    expect(wrapper.find('[data-testid="alert-dot"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="account-trigger"]').attributes('aria-label')).toContain('系统有告警')
    await wrapper.find('[data-testid="account-trigger"]').trigger('click')
    await flushPromises()
    expect(menuEl()!.querySelector('[data-testid="alert-text"]')!.textContent).toContain('95%')
    wrapper.unmount()
  })

  it('没有告警就没有圆点', () => {
    signIn(['sys.ops'])
    const wrapper = mountMenu([])
    expect(wrapper.find('[data-testid="alert-dot"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('键盘:打开后焦点在第一项,↓↑ 循环移动,Esc 关闭并把焦点还给头像', async () => {
    signIn([])
    const wrapper = mountMenu()
    const trigger = wrapper.find('[data-testid="account-trigger"]')
    await trigger.trigger('click')
    await flushPromises()
    const items = [...menuEl()!.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    expect(document.activeElement).toBe(items[0])
    menuEl()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    expect(document.activeElement).toBe(items[1])
    menuEl()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    menuEl()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    expect(document.activeElement).toBe(items[items.length - 1])
    menuEl()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(menuEl()).toBeNull()
    expect(document.activeElement).toBe(trigger.element)
    wrapper.unmount()
  })

  it('点菜单外面关闭', async () => {
    signIn([])
    const wrapper = mountMenu()
    await wrapper.find('[data-testid="account-trigger"]').trigger('click')
    await flushPromises()
    expect(menuEl()).not.toBeNull()
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await flushPromises()
    expect(menuEl()).toBeNull()
    wrapper.unmount()
  })

  it('点「退出登录」发出 signout 并关闭;点「快捷键」发出 shortcuts', async () => {
    signIn([])
    const wrapper = mountMenu()
    await wrapper.find('[data-testid="account-trigger"]').trigger('click')
    await flushPromises()
    ;[...menuEl()!.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent?.includes('快捷键'))!.click()
    await flushPromises()
    expect(wrapper.emitted('shortcuts')).toHaveLength(1)
    await wrapper.find('[data-testid="account-trigger"]').trigger('click')
    await flushPromises()
    menuEl()!.querySelector<HTMLElement>('[data-testid="signout"]')!.click()
    await flushPromises()
    expect(wrapper.emitted('signout')).toHaveLength(1)
    expect(menuEl()).toBeNull()
    wrapper.unmount()
  })
})
