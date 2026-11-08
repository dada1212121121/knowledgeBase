// 邀请码管理:读不到要说原因并可重试;空状态有说明和下一步;撤销后刷新失败不能还显示着旧状态。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const inviteList = vi.fn()
const inviteRevoke = vi.fn()
vi.mock('@/utils/adminApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/adminApi')>()),
  inviteList: (...a: unknown[]) => inviteList(...a),
  inviteRevoke: (...a: unknown[]) => inviteRevoke(...a),
}))

import InviteManager from './InviteManager.vue'
import KbConfirmHost from '@kb-ui/components/KbConfirmHost.vue'
import { CapabilityError } from '@/api/client'

const invite = { id: 'inv_1', prefix: 'KB-7H2K', note: '内测第一批', role_id: null, max_uses: 50, used: 0, expires_at: null, created_at: Date.now() - 3600_000, revoked_at: null }
const $ = (selector: string) => document.body.querySelector<HTMLElement>(selector)
const text = () => document.body.textContent?.replace(/\s+/g, ' ').trim() ?? ''

let wrapper: VueWrapper | null = null
async function open() {
  wrapper = mount(InviteManager, { props: { roles: [] }, attachTo: document.body })
  await flushPromises()
}
beforeEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  setActivePinia(createPinia())
  inviteList.mockReset().mockResolvedValue({ invites: [{ invite, state: 'active' }], now: Date.now() })
  inviteRevoke.mockReset().mockResolvedValue({})
})

describe('邀请码 · 读取状态', () => {
  it('读不到:写原因 + 重试,重试后列表出现', async () => {
    inviteList.mockRejectedValue(new CapabilityError('数据库繁忙', 'internal', 500))
    await open()
    const box = $('[data-testid=admin-error]')
    expect(box?.textContent).toContain('读取邀请码失败')
    inviteList.mockResolvedValue({ invites: [{ invite, state: 'active' }], now: Date.now() })
    box!.querySelector<HTMLButtonElement>('button')!.click()
    await flushPromises()
    expect(text()).toContain('KB-7H2K')
  })

  it('没有邀请码:有说明,有可点的「生成邀请码」(以前说明文字写在了不存在的 hint 属性上,根本不显示)', async () => {
    inviteList.mockResolvedValue({ invites: [], now: Date.now() })
    await open()
    const empty = $('.kb-empty')!
    expect(empty.textContent).toContain('还没有邀请码')
    expect(empty.textContent).toContain('生成后可以发给要邀请的人')
    expect(empty.querySelector('button')?.textContent).toContain('生成邀请码')
  })

  it('撤销成功但刷新列表失败:换成报错,不再显示着刚撤销的码是「可用」', async () => {
    const host = mount(KbConfirmHost, { attachTo: document.body })
    await open()
    ;[...document.body.querySelectorAll('button')].find((button) => button.textContent?.trim() === '撤销')!.click()
    await flushPromises()
    inviteList.mockRejectedValue(new CapabilityError('数据库繁忙', 'internal', 500))
    document.body.querySelector<HTMLButtonElement>('[role=alertdialog] .kb-confirm-btn.is-danger')!.click()
    await flushPromises()
    expect(inviteRevoke).toHaveBeenCalledWith('inv_1')
    expect($('[data-testid=admin-error]')).not.toBeNull()
    host.unmount()
  })

  it('撤销被后端拒绝:确认框里写「撤销邀请码失败:原因」,并说明撤销不能恢复', async () => {
    inviteRevoke.mockRejectedValue(new CapabilityError('这个邀请码已经被撤销', 'exists', 409))
    const host = mount(KbConfirmHost, { attachTo: document.body })
    await open()
    ;[...document.body.querySelectorAll('button')].find((button) => button.textContent?.trim() === '撤销')!.click()
    await flushPromises()
    expect($('[role=alertdialog]')!.textContent).toContain('也不能恢复')
    document.body.querySelector<HTMLButtonElement>('[role=alertdialog] .kb-confirm-btn.is-danger')!.click()
    await flushPromises()
    expect($('[role=alertdialog]')!.textContent).toContain('撤销邀请码失败:这个邀请码已经被撤销')
    host.unmount()
  })
})
