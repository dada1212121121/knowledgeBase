// AI 助手独立页:有功能时渲染助手;没有开通时写「没有开通」,AI 总开关关着时标题和说明里都不出现「AI」。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

// 外壳换成会把 title 写出来的替身,方便断言页面传给顶栏的标题
vi.mock('@/layouts/AppShell.vue', () => ({
  default: { props: { title: { type: String, default: undefined } }, template: '<div class="app-shell" :data-title="title"><slot /></div>' },
}))
vi.mock('@/components/AssistantDrawer.vue', () => ({ default: { template: '<div data-testid="assistant-drawer" />' } }))

import { useSessionStore } from '@/stores/session'
import Agent from './Agent.vue'

const AI_WORD = /(?<![A-Za-z])AI(?![A-Za-z])/

function openWith(features: string[], aiEnabled: boolean) {
  const session = useSessionStore()
  session.features = new Set(features)
  session.aiEnabled = aiEnabled
  session.loaded = true
  return mount(Agent)
}

beforeEach(() => setActivePinia(createPinia()))

describe('Agent · 没有开通', () => {
  it('有 ai.assistant:渲染助手,标题沿用路由名(不传 title)', () => {
    const wrapper = openWith(['ai.assistant'], true)
    expect(wrapper.find('[data-testid=assistant-drawer]').exists()).toBe(true)
    expect(wrapper.find('[data-testid=assistant-off]').exists()).toBe(false)
    expect(wrapper.find('.app-shell').attributes('data-title')).toBeUndefined()
  })

  it('AI 总开关关闭:写「没有开通」,说明和顶栏标题都没有 AI 字样', () => {
    const wrapper = openWith(['docs.notes'], false)
    const off = wrapper.find('[data-testid=assistant-off]')
    expect(off.text()).toContain('你的账号没有开通这个功能')
    expect(off.text()).toContain('请联系管理员')
    expect(wrapper.find('[data-testid=assistant-drawer]').exists()).toBe(false)
    expect(wrapper.find('.app-shell').attributes('data-title')).toBe('功能未开通')
    expect(wrapper.text()).not.toMatch(AI_WORD)
    expect(wrapper.html()).not.toMatch(AI_WORD)
  })

  it('总开关开着、只是角色没勾这个功能:说明里照旧点名是 AI 助手,标题不变', () => {
    const wrapper = openWith(['docs.notes'], true)
    expect(wrapper.find('[data-testid=assistant-off]').text()).toContain('AI 助手需要管理员为你的账号开通')
    expect(wrapper.find('.app-shell').attributes('data-title')).toBeUndefined()
  })
})
