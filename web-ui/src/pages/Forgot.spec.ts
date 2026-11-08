// 找回密码页:取站点状态失败时的重试,以及提交失败的报错。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { AccountError } from '@/api/client'

const authStatus = vi.fn()
const resetPassword = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  authStatus: () => authStatus(),
  resetPassword: (...args: unknown[]) => resetPassword(...args),
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }), RouterLink: { props: ['to'], template: '<a><slot /></a>' } }))

import Forgot from './Forgot.vue'

const $ = <T extends Element = HTMLElement>(selector: string) => document.body.querySelector<T>(selector)
const READY = { registration_open: true, require_invite: false, mail_ready: true, site: { name: '知识库', tagline: '' } }

let wrapper: VueWrapper | null = null
beforeEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  authStatus.mockReset()
  resetPassword.mockReset()
})

describe('Forgot', () => {
  it('连不上服务时:说清楚并给「重试」,点了重新取,取到后显示表单', async () => {
    authStatus.mockRejectedValueOnce(new TypeError('Load failed'))
    authStatus.mockResolvedValue(READY)
    wrapper = mount(Forgot, { attachTo: document.body })
    await flushPromises()
    const alert = $('.auth-box [role=alert]')!.textContent!
    expect(alert).toContain('连不上服务器')
    expect(alert).not.toContain('Load failed')
    expect($('#fg-email')).toBeNull()
    $<HTMLButtonElement>('[data-testid=auth-retry]')!.click()
    await flushPromises()
    expect(authStatus).toHaveBeenCalledTimes(2)
    expect($('[data-testid=auth-retry]')).toBeNull()
    expect($('#fg-email')).not.toBeNull()
  })

  it('重置失败:断网说连不上,没有原因时不露状态码', async () => {
    authStatus.mockResolvedValue(READY)
    wrapper = mount(Forgot, { attachTo: document.body })
    await flushPromises()
    const set = async (selector: string, value: string) => {
      const el = $<HTMLInputElement>(selector)!
      el.value = value
      el.dispatchEvent(new Event('input', { bubbles: true }))
      await flushPromises()
    }
    await set('#fg-email', 'a@example.com')
    await set('#fg-code', '123456')
    await set('#fg-pass', 'a-Strong-pass-123')
    const submit = [...document.body.querySelectorAll('button')].find((button) => button.textContent!.trim() === '重置密码') as HTMLButtonElement
    resetPassword.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    submit.click()
    await flushPromises()
    expect($('.auth-error')!.textContent).toContain('连不上服务器')
    resetPassword.mockRejectedValueOnce(new AccountError('请求失败(502)', 502))
    submit.click()
    await flushPromises()
    expect($('.auth-error')!.textContent).not.toContain('502')
    expect($('.auth-error')!.textContent).toContain('请稍后再试')
  })
})
