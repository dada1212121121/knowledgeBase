// 用户管理里的「重置两步验证」:二次确认并说清后果、请求参数是 user_id、结果提示按原来开没开如实说、失败就地显示。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const userTotpReset = vi.fn()
const user = { id: 'usr_alice', username: 'alice', email: 'alice@example.com', display_name: 'Alice', role_id: 'role_user', status: 'active', avatar: null, last_login_at: null }
vi.mock('@/utils/adminApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/adminApi')>()),
  featureCatalog: vi.fn(async () => ({ features: [] })),
  roleList: vi.fn(async () => ({ roles: [{ id: 'role_user', name: '普通用户', description: '', builtin: true, all_features: false, dangerous: false, features: [], user_count: 1 }] })),
  userList: vi.fn(async () => ({ users: [user], total: 1, page: 1, page_size: 30 })),
  userGet: vi.fn(async () => ({ user, space: null, overrides: [], effective_features: [] })),
  userTotpReset: (...a: unknown[]) => userTotpReset(...a),
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/admin/users', query: {}, meta: {} }),
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('@/layouts/AppShell.vue', () => ({ default: { template: '<div class="app-shell"><slot /></div>' } }))
vi.mock('@/components/InviteManager.vue', () => ({ default: { template: '<div />' } }))

import Users from './Users.vue'
import KbConfirmHost from '@kb-ui/components/KbConfirmHost.vue'
import { toasts } from '@kb-ui/components/useToast'
import { AccountError } from '@/api/client'

const q = (selector: string) => document.body.querySelector(selector) as HTMLElement | null

async function openAlice() {
  const wrapper = mount(Users, { attachTo: document.body })
  await flushPromises()
  const tabs = wrapper.findAll('.kb-ut-tabs button')
  await tabs.find((tab) => tab.text() === '用户')!.trigger('click')
  await flushPromises()
  await wrapper.find('.kb-ut-row').trigger('click')
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  document.body.innerHTML = ''
  userTotpReset.mockReset()
  toasts.splice(0)
})

describe('Users:重置两步验证', () => {
  it('用户详情里有按钮;点它先二次确认,确认之前不发请求,并写明会让所有设备退出', async () => {
    const host = mount(KbConfirmHost, { attachTo: document.body })
    const wrapper = await openAlice()
    expect(q('[data-testid=user-totp-reset]')).not.toBeNull()
    q('[data-testid=user-totp-reset]')!.click()
    await flushPromises()
    const text = document.body.textContent ?? ''
    expect(text).toContain('重置「Alice」的两步验证?')
    expect(text).toContain('所有设备上的登录立即失效')
    expect(text).toContain('记入审计')
    expect(userTotpReset).not.toHaveBeenCalled()
    // 取消:仍然不发
    ;(document.body.querySelector('.kb-confirm-btn:not(.is-danger)') as HTMLElement).click()
    await flushPromises()
    expect(userTotpReset).not.toHaveBeenCalled()
    wrapper.unmount()
    host.unmount()
  })

  it('确认后按 user_id 发请求,提示条如实说明(原来开着)', async () => {
    const host = mount(KbConfirmHost, { attachTo: document.body })
    const wrapper = await openAlice()
    userTotpReset.mockResolvedValueOnce({ id: 'usr_alice', was_enabled: true, sessions_revoked: 3 })
    q('[data-testid=user-totp-reset]')!.click()
    await flushPromises()
    ;(document.body.querySelector('.kb-confirm-btn.is-danger') as HTMLElement).click()
    await flushPromises()
    expect(userTotpReset).toHaveBeenCalledWith('usr_alice')
    expect(toasts[0]?.message).toContain('已关掉他的两步验证')
    expect(toasts[0]?.message).toContain('3 台设备')
    wrapper.unmount()
    host.unmount()
  })

  it('原来就没开:提示条不假装关掉了什么', async () => {
    const host = mount(KbConfirmHost, { attachTo: document.body })
    const wrapper = await openAlice()
    userTotpReset.mockResolvedValueOnce({ id: 'usr_alice', was_enabled: false, sessions_revoked: 0 })
    q('[data-testid=user-totp-reset]')!.click()
    await flushPromises()
    ;(document.body.querySelector('.kb-confirm-btn.is-danger') as HTMLElement).click()
    await flushPromises()
    expect(toasts[0]?.message).toContain('本来就没有开启')
    wrapper.unmount()
    host.unmount()
  })

  it('后端拒绝(例如只有管理员能改管理级账号):就地显示在确认框里,不弹成功提示', async () => {
    const host = mount(KbConfirmHost, { attachTo: document.body })
    const wrapper = await openAlice()
    userTotpReset.mockRejectedValueOnce(new AccountError('这个账号是管理级角色,只有管理员能修改', 403, 0, 'forbidden'))
    q('[data-testid=user-totp-reset]')!.click()
    await flushPromises()
    ;(document.body.querySelector('.kb-confirm-btn.is-danger') as HTMLElement).click()
    await flushPromises()
    expect(document.body.textContent).toContain('只有管理员能修改')
    expect(toasts).toHaveLength(0)
    wrapper.unmount()
    host.unmount()
  })
})
