// 两步验证流程对话框:三个流程、密码用完即清、恢复码只显示一次(不勾「已保存」关不掉、离开前拦截)、错误话术。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { AccountError } from '@/api/client'

const totpSetup = vi.fn()
const totpConfirm = vi.fn()
const totpDisable = vi.fn()
const totpRegenerate = vi.fn()
vi.mock('@/api/totp', () => ({
  totpSetup: (...a: unknown[]) => totpSetup(...a),
  totpConfirm: (...a: unknown[]) => totpConfirm(...a),
  totpDisable: (...a: unknown[]) => totpDisable(...a),
  totpRegenerate: (...a: unknown[]) => totpRegenerate(...a),
}))

let guard: (() => unknown) | null = null
const stopGuard = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({
    beforeEach: (fn: () => unknown) => {
      guard = fn
      return stopGuard
    },
  }),
}))

// 二维码生成走动态 import,这里不关心它画了什么
vi.mock('./TotpQr.vue', () => ({ default: { props: ['uri'], template: '<div class="qr-stub">{{ uri }}</div>' } }))

import TotpFlowDialog from './TotpFlowDialog.vue'
import KbConfirmHost from '@kb-ui/components/KbConfirmHost.vue'

const bad = (status: number, code: string, message = '后端的话') => new AccountError(message, status, 0, code)
const SETUP = { secret: 'JBSWY3DPEHPK3PXP', otpauth_uri: 'otpauth://totp/x:y?secret=JBSWY3DPEHPK3PXP', issuer: 'x' }
const CODES = Array.from({ length: 8 }, (_, i) => `ABCD-EFGH-J${i + 2}K3`)

function open(flow: 'enable' | 'disable' | 'regenerate') {
  return mount(TotpFlowDialog, { props: { flow, account: 'alice', site: '知识库' }, attachTo: document.body })
}
const q = (selector: string) => document.body.querySelector(selector) as HTMLElement | null
const input = (selector: string) => q(selector) as HTMLInputElement
async function type(selector: string, value: string) {
  const el = input(selector)
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  await flushPromises()
}
const click = async (selector: string) => {
  q(selector)!.click()
  await flushPromises()
}

beforeEach(() => {
  document.body.innerHTML = ''
  guard = null
  for (const fn of [totpSetup, totpConfirm, totpDisable, totpRegenerate, stopGuard]) fn.mockReset()
})

describe('开启', () => {
  it('第 1 步:没填密码不能继续;提交后拿到密钥进入第 2 步,密码被清掉', async () => {
    const wrapper = open('enable')
    await flushPromises()
    expect(q('[data-step=password]')).not.toBeNull()
    expect(input('[data-testid=totp-submit]').disabled).toBe(true)
    totpSetup.mockResolvedValueOnce(SETUP)
    await type('input[type=password]', 'old-password-1')
    await click('[data-testid=totp-submit]')
    expect(totpSetup).toHaveBeenCalledWith('old-password-1')
    expect(q('[data-step=scan]')).not.toBeNull()
    expect(q('.qr-stub')!.textContent).toBe(SETUP.otpauth_uri)
    expect(q('[data-testid=totp-secret]')!.textContent).toBe('JBSW Y3DP EHPK 3PXP')
    // 密码不应还留在任何地方
    expect(document.body.innerHTML).not.toContain('old-password-1')
    wrapper.unmount()
  })

  it('密码错:就地提示,密码框清空,不进入下一步', async () => {
    const wrapper = open('enable')
    await flushPromises()
    totpSetup.mockRejectedValueOnce(bad(401, 'bad_password'))
    await type('input[type=password]', 'wrong')
    await click('[data-testid=totp-submit]')
    expect(q('[role=alert]')!.textContent).toContain('密码不对')
    expect(input('input[type=password]').value).toBe('')
    expect(q('[data-step=password]')).not.toBeNull()
    wrapper.unmount()
  })

  it('第 2 步:验证码错清空重输;对了拿到恢复码,并通知外面刷新状态', async () => {
    const wrapper = open('enable')
    await flushPromises()
    totpSetup.mockResolvedValueOnce(SETUP)
    await type('input[type=password]', 'pw')
    await click('[data-testid=totp-submit]')
    totpConfirm.mockRejectedValueOnce(bad(401, 'bad_code'))
    await type('.kb-otp-input', '000000')
    await click('[data-testid=totp-submit]')
    expect(q('[role=alert]')!.textContent).toContain('手机时间')
    expect(input('.kb-otp-input').value).toBe('')
    totpConfirm.mockResolvedValueOnce({ enabled: true, recovery_codes: CODES })
    await type('.kb-otp-input', '123456')
    await click('[data-testid=totp-submit]')
    expect(totpConfirm).toHaveBeenLastCalledWith('123456')
    expect(q('[data-step=codes]')).not.toBeNull()
    expect([...document.body.querySelectorAll('.kb-rc-list code')].map((el) => el.textContent)).toEqual(CODES)
    expect(wrapper.emitted('changed')).toHaveLength(1)
    wrapper.unmount()
  })

  it('已经在别处开启(409):提示并通知外面刷新', async () => {
    const wrapper = open('enable')
    await flushPromises()
    totpSetup.mockRejectedValueOnce(bad(409, 'conflict'))
    await type('input[type=password]', 'pw')
    await click('[data-testid=totp-submit]')
    expect(q('[role=alert]')!.textContent).toContain('已经开启')
    expect(wrapper.emitted('changed')).toHaveLength(1)
    wrapper.unmount()
  })
})

describe('恢复码只显示一次', () => {
  async function toCodes() {
    const wrapper = open('enable')
    await flushPromises()
    totpSetup.mockResolvedValueOnce(SETUP)
    totpConfirm.mockResolvedValueOnce({ enabled: true, recovery_codes: CODES })
    await type('input[type=password]', 'pw')
    await click('[data-testid=totp-submit]')
    await type('.kb-otp-input', '123456')
    await click('[data-testid=totp-submit]')
    return wrapper
  }

  it('没勾「我已保存」:「完成」禁用,点关闭 / Esc 都关不掉并提示', async () => {
    const wrapper = await toCodes()
    expect(input('[data-testid=rc-done]').disabled).toBe(true)
    await click('.kb-dialog-head .btn')
    expect(wrapper.emitted('close')).toBeUndefined()
    expect(q('[data-testid=recovery-codes]')!.textContent).toContain('请先保存恢复码')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(wrapper.emitted('close')).toBeUndefined()
    wrapper.unmount()
  })

  it('勾选之后才能完成并关闭', async () => {
    const wrapper = await toCodes()
    const box = input('[data-testid=rc-saved]')
    box.checked = true
    box.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()
    expect(input('[data-testid=rc-done]').disabled).toBe(false)
    await click('[data-testid=rc-done]')
    expect(wrapper.emitted('close')).toHaveLength(1)
    wrapper.unmount()
  })

  it('没勾就想离开页面:路由守卫拦下并要求确认;勾了之后放行', async () => {
    const host = mount(KbConfirmHost, { attachTo: document.body })
    const wrapper = await toCodes()
    expect(guard).not.toBeNull()
    const pending = guard!() as Promise<boolean>
    await flushPromises()
    expect(document.body.textContent).toContain('恢复码还没保存')
    ;(document.body.querySelector('.kb-confirm-btn:not(.is-danger)') as HTMLElement).click() // 「回去保存」
    await expect(pending).resolves.toBe(false)
    const box = input('[data-testid=rc-saved]')
    box.checked = true
    box.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()
    await expect(Promise.resolve(guard!())).resolves.toBe(true)
    wrapper.unmount()
    host.unmount()
    expect(stopGuard).toHaveBeenCalled()
  })

  it('没勾就刷新 / 关标签:浏览器的离开提示被触发;勾了之后不拦', async () => {
    const wrapper = await toCodes()
    const event = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    const box = input('[data-testid=rc-saved]')
    box.checked = true
    box.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()
    const again = new Event('beforeunload', { cancelable: true }) as BeforeUnloadEvent
    window.dispatchEvent(again)
    expect(again.defaultPrevented).toBe(false)
    wrapper.unmount()
  })

  it('还没到恢复码那一步时,离开不被拦', async () => {
    const wrapper = open('enable')
    await flushPromises()
    await expect(Promise.resolve(guard!())).resolves.toBe(true)
    wrapper.unmount()
  })
})

describe('关闭与重新生成', () => {
  it('关闭:要密码 + 验证码,成功后通知刷新并关掉对话框', async () => {
    const wrapper = open('disable')
    await flushPromises()
    expect(q('[data-step=verify]')).not.toBeNull()
    expect(input('[data-testid=totp-submit]').disabled).toBe(true)
    totpDisable.mockResolvedValueOnce({ enabled: false })
    await type('input[type=password]', 'pw')
    await type('.kb-otp-input', '123456')
    expect(input('[data-testid=totp-submit]').disabled).toBe(false)
    await click('[data-testid=totp-submit]')
    expect(totpDisable).toHaveBeenCalledWith('pw', '123456')
    expect(wrapper.emitted('changed')).toHaveLength(1)
    expect(wrapper.emitted('close')).toHaveLength(1)
    wrapper.unmount()
  })

  it('可以改用恢复码关闭,提交的是规整后的恢复码', async () => {
    const wrapper = open('disable')
    await flushPromises()
    await click('.kb-cf-switch')
    totpDisable.mockResolvedValueOnce({ enabled: false })
    await type('input[type=password]', 'pw')
    await type('.kb-cf-recovery', ' abcd-efgh-j2k3 ')
    await click('[data-testid=totp-submit]')
    expect(totpDisable).toHaveBeenCalledWith('pw', 'ABCD-EFGH-J2K3')
    wrapper.unmount()
  })

  it('验证码错:清空验证码但保留密码;密码错:清空密码', async () => {
    const wrapper = open('disable')
    await flushPromises()
    totpDisable.mockRejectedValueOnce(bad(401, 'bad_code'))
    await type('input[type=password]', 'pw')
    await type('.kb-otp-input', '000000')
    await click('[data-testid=totp-submit]')
    expect(input('.kb-otp-input').value).toBe('')
    expect(input('input[type=password]').value).toBe('pw')
    totpDisable.mockRejectedValueOnce(bad(401, 'bad_password'))
    await type('.kb-otp-input', '123456')
    await click('[data-testid=totp-submit]')
    expect(input('input[type=password]').value).toBe('')
    wrapper.unmount()
  })

  it('站点强制时后端拒绝关闭(403 totp_required):说明原因', async () => {
    const wrapper = open('disable')
    await flushPromises()
    totpDisable.mockRejectedValueOnce(bad(403, 'totp_required'))
    await type('input[type=password]', 'pw')
    await type('.kb-otp-input', '123456')
    await click('[data-testid=totp-submit]')
    expect(q('[role=alert]')!.textContent).toContain('必须开启')
    wrapper.unmount()
  })

  it('次数太多(429):说等一会儿,不关对话框', async () => {
    const wrapper = open('disable')
    await flushPromises()
    totpDisable.mockRejectedValueOnce(bad(429, 'rate_limited'))
    await type('input[type=password]', 'pw')
    await type('.kb-otp-input', '123456')
    await click('[data-testid=totp-submit]')
    expect(q('[role=alert]')!.textContent).toContain('15 分钟')
    expect(wrapper.emitted('close')).toBeUndefined()
    wrapper.unmount()
  })

  it('重新生成:成功后显示新的恢复码,同样要勾选才能关', async () => {
    const wrapper = open('regenerate')
    await flushPromises()
    totpRegenerate.mockResolvedValueOnce({ recovery_codes: CODES })
    await type('input[type=password]', 'pw')
    await type('.kb-otp-input', '123456')
    await click('[data-testid=totp-submit]')
    expect(totpRegenerate).toHaveBeenCalledWith('pw', '123456')
    expect(q('[data-step=codes]')).not.toBeNull()
    expect(input('[data-testid=rc-done]').disabled).toBe(true)
    expect(wrapper.emitted('changed')).toHaveLength(1)
    wrapper.unmount()
  })
})
