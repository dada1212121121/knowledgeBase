// 用户与权限:读不到角色 / 读不到用户列表 / 没开通,都要说清楚原因并给重试,不能是错误徽标或「没有符合条件的用户」。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const featureCatalog = vi.fn()
const roleList = vi.fn()
const userList = vi.fn()
const user = { id: 'usr_alice', username: 'alice', email: null, display_name: 'Alice', role_id: 'role_user', status: 'active', avatar: null, last_login_at: null }
const role = { id: 'role_user', name: '普通用户', description: '', builtin: true, all_features: false, dangerous: false, features: [], user_count: 1, quota_json: '{}' }
vi.mock('@/utils/adminApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/adminApi')>()),
  featureCatalog: (...a: unknown[]) => featureCatalog(...a),
  roleList: (...a: unknown[]) => roleList(...a),
  userList: (...a: unknown[]) => userList(...a),
}))
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  callCapability: vi.fn(async () => ({})),
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/admin/users', query: {}, meta: {} }),
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('@/layouts/AppShell.vue', () => ({ default: { template: '<div class="app-shell"><slot /></div>' } }))
vi.mock('@/components/InviteManager.vue', () => ({ default: { template: '<div class="invite-stub" />' } }))

import Users from './Users.vue'
import { CapabilityError } from '@/api/client'

const $ = (selector: string) => document.body.querySelector<HTMLElement>(selector)
const text = () => document.body.textContent?.replace(/\s+/g, ' ').trim() ?? ''

let wrapper: VueWrapper | null = null
async function open() {
  wrapper = mount(Users, { attachTo: document.body })
  await flushPromises()
}
async function openUsersTab() {
  await wrapper!.findAll('.kb-ut-tabs button').find((tab) => tab.text() === '用户')!.trigger('click')
  await vi.advanceTimersByTimeAsync(0)
  await flushPromises()
}

beforeEach(() => {
  vi.useFakeTimers()
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  setActivePinia(createPinia())
  featureCatalog.mockReset().mockResolvedValue({ features: [] })
  roleList.mockReset().mockResolvedValue({ roles: [role] })
  userList.mockReset().mockResolvedValue({ users: [user], total: 1, page: 1, page_size: 30 })
})

describe('用户与权限 · 读取状态', () => {
  it('角色读不到:整页写清原因 + 重试,没有页签和新建按钮;重试后恢复', async () => {
    roleList.mockRejectedValue(new CapabilityError('数据库繁忙', 'internal', 500))
    await open()
    const box = $('[data-testid=admin-error]')
    expect(box).not.toBeNull()
    expect(box!.textContent).toContain('读取角色和功能失败')
    expect($('.kb-ut-tabs')).toBeNull()
    expect(text()).not.toContain('新建角色')
    roleList.mockResolvedValue({ roles: [role] })
    box!.querySelector<HTMLButtonElement>('button')!.click()
    await flushPromises()
    expect($('[data-testid=admin-error]')).toBeNull()
    expect($('.kb-ut-tabs')).not.toBeNull()
    expect(text()).toContain('新建角色')
  })

  it('没有开通「用户、角色与邀请码」:说明没开通,不给重试', async () => {
    roleList.mockRejectedValue(new CapabilityError('forbidden', 'forbidden', 403))
    await open()
    expect($('[data-testid=admin-forbidden]')).not.toBeNull()
    expect($('[data-testid=admin-forbidden]')!.querySelector('button')).toBeNull()
    expect($('.kb-ut-tabs')).toBeNull()
  })

  it('用户列表读不到:列表位置写原因 + 重试,不是「没有符合条件的用户」', async () => {
    await open()
    userList.mockRejectedValue(new CapabilityError('数据库繁忙', 'internal', 500))
    await openUsersTab()
    const box = $('[data-testid=admin-error]')
    expect(box).not.toBeNull()
    expect(box!.textContent).toContain('读取用户列表失败')
    expect(text()).not.toContain('没有符合条件的用户')
    // 页签还在,可以切回去
    expect($('.kb-ut-tabs')).not.toBeNull()
    userList.mockResolvedValue({ users: [user], total: 1, page: 1, page_size: 30 })
    box!.querySelector<HTMLButtonElement>('button')!.click()
    await flushPromises()
    expect($('[data-testid=admin-error]')).toBeNull()
    expect(text()).toContain('Alice')
  })

  it('搜不到人:写「没有符合条件的用户」并给「清除筛选」,点了回到全部', async () => {
    await open()
    await openUsersTab()
    userList.mockResolvedValue({ users: [], total: 0, page: 1, page_size: 30 })
    const input = $('.kb-ut-filter input') as HTMLInputElement
    input.value = '没有这个人'
    input.dispatchEvent(new Event('input'))
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()
    expect(text()).toContain('没有符合条件的用户')
    expect(text()).toContain('换个关键字')
    userList.mockResolvedValue({ users: [user], total: 1, page: 1, page_size: 30 })
    const clear = [...document.body.querySelectorAll('button')].find((button) => button.textContent?.trim() === '清除筛选')!
    clear.click()
    await vi.advanceTimersByTimeAsync(300)
    await flushPromises()
    expect(text()).toContain('Alice')
    expect(input.value).toBe('')
  })
})
