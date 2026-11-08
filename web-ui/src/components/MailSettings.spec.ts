// 邮件设置:读不到只影响这一块,写原因并给重试,不是一枚红色徽标。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const mailStatus = vi.fn()
const mailLog = vi.fn()
vi.mock('@/utils/adminApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/adminApi')>()),
  mailStatus: (...a: unknown[]) => mailStatus(...a),
  mailLog: (...a: unknown[]) => mailLog(...a),
}))
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  callCapability: vi.fn(async () => ({})),
}))

import MailSettings from './MailSettings.vue'
import { CapabilityError } from '@/api/client'

const account = { preset: 'qq', host: 'smtp.qq.com', port: 465, security: 'tls', username: 'a@qq.com', configured: true, password_set: true }
const status = { enabled: true, ready: true, from_name: '', per_minute: 20, sent_last_hour: 0, presets: [], primary: account, backup: { ...account, configured: false, password_set: false, host: '', username: '' } }
const $ = (selector: string) => document.body.querySelector<HTMLElement>(selector)

let wrapper: VueWrapper | null = null
beforeEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  setActivePinia(createPinia())
  mailStatus.mockReset().mockResolvedValue(status)
  mailLog.mockReset().mockResolvedValue({ log: [] })
})

describe('邮件设置 · 读取状态', () => {
  it('读不到:写「读取邮件设置失败」+ 重试;重试后出现设置', async () => {
    mailStatus.mockRejectedValue(new CapabilityError('邮件模块没有启动', 'internal', 503))
    wrapper = mount(MailSettings, { attachTo: document.body })
    await flushPromises()
    const box = $('[data-testid=admin-error]')
    expect(box?.textContent).toContain('读取邮件设置失败:邮件模块没有启动')
    expect(box?.textContent).toContain('重试')
    mailStatus.mockResolvedValue(status)
    box!.querySelector<HTMLButtonElement>('button')!.click()
    await flushPromises()
    expect($('[data-testid=admin-error]')).toBeNull()
    expect(document.body.textContent).toContain('启用邮件')
  })
})

describe('邮件设置 · 控件名字', () => {
  it('启用邮件、发件人名称、每分钟发信上限三个控件都有名字,上限在手机上弹数字键盘', async () => {
    wrapper = mount(MailSettings, { attachTo: document.body })
    await flushPromises()
    expect($('[role=switch][aria-label="启用邮件"], .sw[aria-label="启用邮件"]')).not.toBeNull()
    expect($('input[aria-label="发件人名称"]')).not.toBeNull()
    expect($('input[aria-label="全站每分钟最多发信"]')?.getAttribute('inputmode')).toBe('numeric')
  })
})
