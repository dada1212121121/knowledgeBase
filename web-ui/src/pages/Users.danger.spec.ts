// 用户与权限 · 危险操作:重设密码、改成管理员、停用账号、删除角色都要先确认并写明后果;不可能成功的操作不让点。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const userSetPassword = vi.fn()
const userUpdate = vi.fn()
const roleDelete = vi.fn()
const alice = { id: 'usr_alice', username: 'alice', email: null, display_name: 'Alice', role_id: 'role_user', status: 'active', avatar: null, last_login_at: null, quota_json: '{}' }
const roles = [
  { id: 'role_admin', name: '管理员', description: '', builtin: true, all_features: true, dangerous: true, features: [], user_count: 1, quota_json: '{}' },
  { id: 'role_user', name: '普通用户', description: '', builtin: true, all_features: false, dangerous: false, features: [], user_count: 1, quota_json: '{}' },
  { id: 'role_team', name: '编辑组', description: '', builtin: false, all_features: false, dangerous: false, features: [], user_count: 2, quota_json: '{}' },
  { id: 'role_empty', name: '空角色', description: '', builtin: false, all_features: false, dangerous: false, features: [], user_count: 0, quota_json: '{}' },
]
vi.mock('@/utils/adminApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/adminApi')>()),
  featureCatalog: vi.fn(async () => ({ features: [] })),
  roleList: vi.fn(async () => ({ roles })),
  roleDelete: (...a: unknown[]) => roleDelete(...a),
  userList: vi.fn(async () => ({ users: [alice], total: 1, page: 1, page_size: 30 })),
  userGet: vi.fn(async (id: string) => ({ user: id === 'usr_me' ? { ...alice, id: 'usr_me', username: 'me', display_name: '我' } : alice, space: null, overrides: [], effective_features: [] })),
  userUpdate: (...a: unknown[]) => userUpdate(...a),
  userSetPassword: (...a: unknown[]) => userSetPassword(...a),
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
vi.mock('@/components/InviteManager.vue', () => ({ default: { template: '<div />' } }))

import Users from './Users.vue'
import KbConfirmHost from '@kb-ui/components/KbConfirmHost.vue'
import { toasts } from '@kb-ui/components/useToast'
import { cancelConfirm } from '@kb-ui/components/useConfirm'
import { CapabilityError } from '@/api/client'
import { useSessionStore } from '@/stores/session'

const $ = (selector: string) => document.body.querySelector<HTMLElement>(selector)
const text = () => document.body.textContent?.replace(/\s+/g, ' ').trim() ?? ''
const buttonByText = (label: string) => [...document.body.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === label)

let wrapper: VueWrapper | null = null
let host: VueWrapper | null = null
async function open(myId = 'usr_x') {
  const session = useSessionStore()
  session.user = { id: myId, username: 'me', display_name: '我', email: null, role_id: 'role_admin', space_id: null, must_change_password: false } as never
  session.aiEnabled = true
  host = mount(KbConfirmHost, { attachTo: document.body })
  wrapper = mount(Users, { attachTo: document.body })
  await flushPromises()
}
async function openAlice() {
  await wrapper!.findAll('.kb-ut-tabs button').find((tab) => tab.text() === '用户')!.trigger('click')
  await flushPromises()
  await wrapper!.find('.kb-ut-row').trigger('click')
  await flushPromises()
}
const confirmButton = () => $('[role=alertdialog] .kb-confirm-btn.is-danger') ?? $('[role=alertdialog] .kb-confirm-btn.is-primary')

// 确认框的状态是模块级单例:上一个用例没关掉的确认框会漏到下一个用例里
afterEach(() => cancelConfirm())
beforeEach(() => {
  wrapper?.unmount()
  host?.unmount()
  wrapper = null
  host = null
  document.body.innerHTML = ''
  setActivePinia(createPinia())
  toasts.splice(0)
  userSetPassword.mockReset().mockResolvedValue({})
  userUpdate.mockReset().mockResolvedValue({})
  roleDelete.mockReset().mockResolvedValue({})
})

describe('用户与权限 · 重设密码', () => {
  async function typePassword(value: string) {
    const input = $('.kb-ut-inline input') as HTMLInputElement
    input.value = value
    input.dispatchEvent(new Event('input'))
    await flushPromises()
  }

  it('点「重设」先确认:写明旧密码作废、所有设备退出、记入审计;确认之前不发请求', async () => {
    await open()
    await openAlice()
    await typePassword('longenough1')
    buttonByText('重设')!.click()
    await flushPromises()
    expect(text()).toContain('重设「Alice」的密码?')
    expect(text()).toContain('所有设备上的登录都会失效')
    expect(text()).toContain('记入审计')
    expect(userSetPassword).not.toHaveBeenCalled()
  })

  it('确认后才发请求并清空输入框;取消则什么都不发,输入框保留', async () => {
    await open()
    await openAlice()
    await typePassword('longenough1')
    buttonByText('重设')!.click()
    await flushPromises()
    buttonByText('取消')!.click()
    await flushPromises()
    expect(userSetPassword).not.toHaveBeenCalled()
    expect(($('.kb-ut-inline input') as HTMLInputElement).value).toBe('longenough1')
    buttonByText('重设')!.click()
    await flushPromises()
    confirmButton()!.click()
    await flushPromises()
    expect(userSetPassword).toHaveBeenCalledWith('usr_alice', 'longenough1')
    expect(($('.kb-ut-inline input') as HTMLInputElement).value).toBe('')
    expect(toasts.at(-1)?.message).toContain('所有设备已退出登录')
  })

  it('后端拒绝:就地显示「做什么失败 + 原因」,不露英文', async () => {
    userSetPassword.mockRejectedValue(new CapabilityError('只有管理员能改管理级账号', 'forbidden', 409))
    await open()
    await openAlice()
    await typePassword('longenough1')
    buttonByText('重设')!.click()
    await flushPromises()
    confirmButton()!.click()
    await flushPromises()
    expect($('[role=alertdialog]')!.textContent).toContain('重设密码失败:只有管理员能改管理级账号')
  })
})

describe('用户与权限 · 改成管理员', () => {
  async function pick(value: string) {
    const select = $('.kb-dlg select, [role=dialog] select') as HTMLSelectElement
    select.value = value
    select.dispatchEvent(new Event('change'))
    await flushPromises()
    return select
  }

  it('改成管理员要确认并写明权力范围;取消后下拉框拨回原来的角色,不发请求', async () => {
    await open()
    await openAlice()
    const select = await pick('role_admin')
    expect(text()).toContain('把「Alice」设为管理员?')
    expect(text()).toContain('包括管理用户和全站设置')
    expect(userUpdate).not.toHaveBeenCalled()
    buttonByText('取消')!.click()
    await flushPromises()
    expect(userUpdate).not.toHaveBeenCalled()
    expect(select.value).toBe('role_user')
  })

  it('确认后才改', async () => {
    await open()
    await openAlice()
    await pick('role_admin')
    confirmButton()!.click()
    await flushPromises()
    expect(userUpdate).toHaveBeenCalledWith({ id: 'usr_alice', role_id: 'role_admin' })
  })

  it('改成普通角色不弹确认,直接生效', async () => {
    await open()
    await openAlice()
    await pick('role_team')
    expect($('[role=alertdialog]')).toBeNull()
    expect(userUpdate).toHaveBeenCalledWith({ id: 'usr_alice', role_id: 'role_team' })
  })
})

describe('用户与权限 · 停用账号', () => {
  it('停用要确认,写明退出所有设备、令牌失效、数据保留', async () => {
    await open()
    await openAlice()
    buttonByText('停用账号')!.click()
    await flushPromises()
    expect(text()).toContain('停用「alice」?')
    expect(text()).toContain('退出所有设备')
    expect(text()).toContain('笔记和文件都保留')
    expect(userUpdate).not.toHaveBeenCalled()
  })

  it('自己的账号不能停用:按钮置灰并写明原因', async () => {
    await open('usr_alice')
    await openAlice()
    expect(buttonByText('停用账号')!.disabled).toBe(true)
    expect($('[data-testid=self-note]')?.textContent).toContain('不能停用')
  })
})

describe('用户与权限 · 删除角色', () => {
  async function selectRole(name: string) {
    ;[...document.body.querySelectorAll<HTMLButtonElement>('.kb-ut-role')].find((button) => button.textContent?.includes(name))!.click()
    await flushPromises()
  }

  it('还有人在用的角色:删除按钮置灰,写明还有几个人,不弹确认', async () => {
    await open()
    await selectRole('编辑组')
    expect(buttonByText('删除角色')!.disabled).toBe(true)
    expect($('[data-testid=role-in-use]')?.textContent).toContain('还有 2 个用户在用这个角色')
    buttonByText('删除角色')!.click()
    await flushPromises()
    expect($('[role=alertdialog]')).toBeNull()
    expect(roleDelete).not.toHaveBeenCalled()
  })

  it('没人用的角色:确认里写明不能恢复、配额覆盖会丢;确认后才删', async () => {
    await open()
    await selectRole('空角色')
    expect($('[data-testid=role-in-use]')).toBeNull()
    buttonByText('删除角色')!.click()
    await flushPromises()
    expect(text()).toContain('删除角色「空角色」?')
    expect(text()).toContain('删除后不能恢复')
    expect(roleDelete).not.toHaveBeenCalled()
    confirmButton()!.click()
    await flushPromises()
    expect(roleDelete).toHaveBeenCalledWith('role_empty')
  })

  it('后端拒绝:确认框里写「删除角色失败:原因」,不露英文', async () => {
    roleDelete.mockRejectedValue(new CapabilityError('还有 1 个用户在使用这个角色,请先改成别的角色', 'exists', 409))
    await open()
    await selectRole('空角色')
    buttonByText('删除角色')!.click()
    await flushPromises()
    confirmButton()!.click()
    await flushPromises()
    expect($('[role=alertdialog]')!.textContent).toContain('删除角色失败:还有 1 个用户在使用这个角色,请先改成别的角色')
  })

  it('内置角色没有删除按钮', async () => {
    await open()
    await selectRole('普通用户')
    expect(buttonByText('删除角色')).toBeUndefined()
  })
})

describe('用户与权限 · 详情里的事实', () => {
  it('注册方式和已用存储按人话写:不露 invite:inv_… 这样的标识,也不写 102400.0 MB', async () => {
    const { userGet } = await import('@/utils/adminApi')
    vi.mocked(userGet).mockResolvedValueOnce({
      user: { ...alice, registered_via: 'invite:inv_8f21' } as never,
      space: { id: 'sp_alice', storage_bytes: 100 * 1024 ** 3 },
      overrides: [],
      effective_features: [],
    })
    await open()
    await openAlice()
    expect(text()).toContain('注册方式:邀请码注册')
    expect(text()).not.toContain('inv_8f21')
    expect(text()).toContain('已用存储:100 GB')
    expect(text()).not.toMatch(/\d+\.\d MB/)
  })
})
