import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

vi.mock('vue-router', () => ({
  RouterLink: { name: 'RouterLink', props: ['to'], template: '<a class="router-link" :href="to"><slot /></a>' },
}))
import ShellTabbar, { type TabEntry } from './ShellTabbar.vue'

const tabs: TabEntry[] = [
  { id: 'home', label: '首页', icon: 'home', to: '/home', active: false },
  { id: 'notify', label: '通知', icon: 'bell', active: false, count: 120 },
  { id: 'mine', label: '我的', icon: 'user', to: '/mine', active: true },
]

describe('ShellTabbar', () => {
  it('有地址的是链接,没有地址的(通知)是按钮;当前项有 aria-current', () => {
    const wrapper = mount(ShellTabbar, { props: { tabs } })
    expect(wrapper.find('[data-tab="home"]').element.tagName).toBe('A')
    expect(wrapper.find('[data-tab="notify"]').element.tagName).toBe('BUTTON')
    expect(wrapper.find('[data-tab="mine"]').attributes('aria-current')).toBe('page')
    expect(wrapper.find('[data-tab="home"]').attributes('aria-current')).toBeUndefined()
  })
  it('通知按钮点击发出 action;角标超过 99 显示 99+,aria-label 带数量', async () => {
    const wrapper = mount(ShellTabbar, { props: { tabs } })
    await wrapper.find('[data-tab="notify"]').trigger('click')
    expect(wrapper.emitted('action')).toEqual([['notify']])
    expect(wrapper.find('[data-testid="tab-badge-notify"]').text()).toBe('99+')
    expect(wrapper.find('[data-tab="notify"]').attributes('aria-label')).toBe('通知,120 条未读')
  })
  it('没有未读时没有角标', () => {
    const wrapper = mount(ShellTabbar, { props: { tabs: [{ id: 'notify', label: '通知', icon: 'bell', active: false }] } })
    expect(wrapper.find('.kb-tab-badge').exists()).toBe(false)
  })
})
