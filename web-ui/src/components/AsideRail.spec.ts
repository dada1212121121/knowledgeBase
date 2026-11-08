// 宽屏右栏:审核收件箱卡片和 G R / G S 提示按功能点显示;AI 总开关关闭时整栏没有「AI」和旧叫法「进化」。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const push = vi.fn()
vi.mock('vue-router', () => ({ useRouter: () => ({ push }) }))

import { useSessionStore } from '@/stores/session'
import { useShellStore } from '@/stores/shell'
import AsideRail from './AsideRail.vue'

const AI_WORD = /(?<![A-Za-z])AI(?![A-Za-z])/

function open(features: string[]) {
  const session = useSessionStore()
  session.features = new Set(features)
  session.loaded = true
  useShellStore().drafts = 7
  return mount(AsideRail)
}

beforeEach(() => {
  push.mockReset()
  setActivePinia(createPinia())
})

describe('AsideRail', () => {
  it('有审核功能:显示待审数、「去审核」能跳转、快捷键里有 G R', async () => {
    const wrapper = open(['search.basic', 'ai.extract'])
    const card = wrapper.find('[data-testid=rail-review]')
    expect(card.text()).toContain('7 条')
    await card.find('button').trigger('click')
    expect(push).toHaveBeenCalledWith('/review')
    expect(wrapper.text()).toContain('G R')
    expect(wrapper.text()).toContain('G S')
  })

  it('没有审核功能(AI 总开关关闭):没有审核卡片,没有 G R,整栏没有 AI 字样,也没有旧叫法「进化」', () => {
    const wrapper = open(['search.basic'])
    expect(wrapper.find('[data-testid=rail-review]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('审核')
    expect(wrapper.text()).not.toContain('G R')
    expect(wrapper.text()).not.toMatch(AI_WORD)
    expect(wrapper.text()).not.toContain('进化')
    // 其余照常
    expect(wrapper.text()).toContain('新增笔记')
    expect(wrapper.text()).toContain('G S')
  })

  it('没有搜索功能:不写「去搜索 G S」', () => {
    const wrapper = open(['ai.extract'])
    expect(wrapper.text()).not.toContain('G S')
  })
})
