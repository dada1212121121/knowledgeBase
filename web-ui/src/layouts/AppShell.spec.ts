// 页面框架 AppShell:把页面标题传送进常驻外壳的顶栏。这里只验证标题的来源——
// 默认取路由名,页面可以用 title 覆盖(「没有开通」页不能沿用带「AI」字样的路由名)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'

const route = vi.hoisted(() => ({ path: '/assistant', meta: { title: 'AI 助手' } as Record<string, unknown> }))
vi.mock('vue-router', () => ({ useRoute: () => route }))
vi.mock('@/components/AsideRail.vue', () => ({ default: { template: '<aside />' } }))

import AppShell from './AppShell.vue'

let wrapper: VueWrapper | null = null
async function open(props: Record<string, unknown> = {}) {
  wrapper = mount(AppShell, { props, slots: { default: '<p>内容</p>' }, attachTo: document.body })
  await wrapper.vm.$nextTick()
  await wrapper.vm.$nextTick()
}
const slotText = (id: string) => document.getElementById(id)?.textContent?.trim() ?? ''

beforeEach(() => {
  document.body.innerHTML = '<div id="kb-slot-bc"></div><div id="kb-slot-mbar"></div><div id="kb-slot-actions"></div>'
  route.meta = { title: 'AI 助手' }
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

describe('AppShell · 顶栏标题', () => {
  it('默认取路由名:桌面面包屑和手机顶栏都是它', async () => {
    await open()
    expect(slotText('kb-slot-bc')).toBe('AI 助手')
    expect(slotText('kb-slot-mbar')).toBe('AI 助手')
  })

  it('路由名里「 · 」后面的部分不进标题', async () => {
    route.meta = { title: '审计 · 批次' }
    await open()
    expect(slotText('kb-slot-mbar')).toBe('审计')
  })

  it('页面传了 title 就用它,桌面和手机都不再出现路由名', async () => {
    await open({ title: '功能未开通' })
    expect(slotText('kb-slot-bc')).toBe('功能未开通')
    expect(slotText('kb-slot-mbar')).toBe('功能未开通')
    expect(document.body.textContent).not.toContain('AI')
  })
})
