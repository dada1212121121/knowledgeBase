// 个人设置里的两步验证卡片:加载 / 报错 / 无权限 / 未开启 / 已开启 / 站点强制,以及全局拦截用的标记。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { AccountError } from '@/api/client'

const totpStatus = vi.fn()
vi.mock('@/api/totp', () => ({ totpStatus: () => totpStatus() }))
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  authStatus: vi.fn(async () => ({ site: { name: '我的知识库', tagline: '' } })),
}))
vi.mock('./TotpFlowDialog.vue', () => ({
  default: { props: ['flow', 'account', 'site'], emits: ['close', 'changed'], template: '<div class="flow-stub" :data-flow="flow" :data-site="site"></div>' },
}))

import TotpCard from './TotpCard.vue'
import { useSessionStore } from '@/stores/session'

const state = (patch: Partial<{ enabled: boolean; recovery_codes_left: number; required: boolean }> = {}) => ({ enabled: false, recovery_codes_left: 0, required: false, ...patch })
const find = (wrapper: ReturnType<typeof mount>, id: string) => wrapper.find(`[data-testid="${id}"]`)

beforeEach(() => {
  setActivePinia(createPinia())
  totpStatus.mockReset()
})

describe('TotpCard', () => {
  it('加载中显示骨架屏,不显示任何按钮', async () => {
    totpStatus.mockReturnValue(new Promise(() => undefined))
    const wrapper = mount(TotpCard)
    await flushPromises()
    expect(wrapper.find('.kb-skel').exists()).toBe(true)
    expect(find(wrapper, 'totp-enable').exists()).toBe(false)
  })

  it('未开启:徽标「未开启」,有「开启」按钮,点它打开开启流程(带站点名)', async () => {
    totpStatus.mockResolvedValue(state())
    const wrapper = mount(TotpCard)
    await flushPromises()
    expect(find(wrapper, 'totp-badge').text()).toBe('未开启')
    expect(find(wrapper, 'totp-must').exists()).toBe(false)
    await find(wrapper, 'totp-enable').trigger('click')
    const flow = wrapper.find('.flow-stub')
    expect(flow.attributes('data-flow')).toBe('enable')
    expect(flow.attributes('data-site')).toBe('我的知识库')
  })

  it('已开启:显示剩余恢复码、重新生成、关闭;够用时不催', async () => {
    totpStatus.mockResolvedValue(state({ enabled: true, recovery_codes_left: 8 }))
    const wrapper = mount(TotpCard)
    await flushPromises()
    expect(find(wrapper, 'totp-badge').text()).toBe('已开启')
    expect(find(wrapper, 'totp-left').text()).toContain('剩余恢复码 8 个')
    expect(find(wrapper, 'totp-left').text()).not.toContain('快用完')
    expect(find(wrapper, 'totp-disable').exists()).toBe(true)
    await find(wrapper, 'totp-regenerate').trigger('click')
    expect(wrapper.find('.flow-stub').attributes('data-flow')).toBe('regenerate')
  })

  it('恢复码快用完 / 用完了:分别提醒', async () => {
    totpStatus.mockResolvedValue(state({ enabled: true, recovery_codes_left: 2 }))
    let wrapper = mount(TotpCard)
    await flushPromises()
    expect(find(wrapper, 'totp-left').text()).toContain('快用完了')
    totpStatus.mockResolvedValue(state({ enabled: true, recovery_codes_left: 0 }))
    wrapper = mount(TotpCard)
    await flushPromises()
    expect(find(wrapper, 'totp-left').text()).toContain('已经用完')
  })

  it('站点要求且还没开:徽标「必须开启」、解释原因,并置位全局拦截标记', async () => {
    totpStatus.mockResolvedValue(state({ required: true }))
    const wrapper = mount(TotpCard)
    await flushPromises()
    expect(find(wrapper, 'totp-badge').text()).toBe('必须开启')
    expect(find(wrapper, 'totp-must').text()).toContain('必须开启两步验证')
    expect(useSessionStore().needsTotpSetup).toBe(true)
  })

  it('站点要求且已开启:没有「关闭」按钮并说明原因;全局拦截标记放下', async () => {
    useSessionStore().needsTotpSetup = true
    totpStatus.mockResolvedValue(state({ enabled: true, required: true, recovery_codes_left: 8 }))
    const wrapper = mount(TotpCard)
    await flushPromises()
    expect(find(wrapper, 'totp-disable').exists()).toBe(false)
    expect(find(wrapper, 'totp-locked').text()).toContain('不能关闭')
    expect(useSessionStore().needsTotpSetup).toBe(false)
  })

  it('不强制:没开也不置位拦截标记', async () => {
    totpStatus.mockResolvedValue(state())
    mount(TotpCard)
    await flushPromises()
    expect(useSessionStore().needsTotpSetup).toBe(false)
  })

  it('报错:给人话和重试;重试成功后恢复正常', async () => {
    totpStatus.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const wrapper = mount(TotpCard)
    await flushPromises()
    const failure = find(wrapper, 'totp-failure')
    expect(failure.text()).toContain('连不上服务器')
    expect(failure.text()).not.toMatch(/fetch/i)
    totpStatus.mockResolvedValue(state())
    await failure.find('button').trigger('click')
    await flushPromises()
    expect(find(wrapper, 'totp-failure').exists()).toBe(false)
    expect(find(wrapper, 'totp-enable').exists()).toBe(true)
  })

  it('服务端报错带上后端的话并提示重试', async () => {
    totpStatus.mockRejectedValueOnce(new AccountError('服务暂时不可用', 500, 0, 'internal'))
    const wrapper = mount(TotpCard)
    await flushPromises()
    expect(find(wrapper, 'totp-failure').text()).toContain('服务暂时不可用。请重试。')
  })

  it('无权限(403):用统一话术,不给重试', async () => {
    totpStatus.mockRejectedValueOnce(new AccountError('只有在浏览器里登录后才能设置两步验证', 403, 0, 'forbidden'))
    const wrapper = mount(TotpCard)
    await flushPromises()
    const failure = find(wrapper, 'totp-failure')
    expect(failure.text()).toContain('没有开通这个功能,请联系管理员')
    expect(failure.find('button').exists()).toBe(false)
  })

  it('流程里改了状态(changed)就重新读取', async () => {
    totpStatus.mockResolvedValueOnce(state())
    const wrapper = mount(TotpCard)
    await flushPromises()
    await find(wrapper, 'totp-enable').trigger('click')
    totpStatus.mockResolvedValueOnce(state({ enabled: true, recovery_codes_left: 8 }))
    ;(wrapper.findComponent('.flow-stub') as VueWrapper).vm.$emit('changed')
    await flushPromises()
    expect(find(wrapper, 'totp-badge').text()).toBe('已开启')
    expect(totpStatus).toHaveBeenCalledTimes(2)
  })
})
