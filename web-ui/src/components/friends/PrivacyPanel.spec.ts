// 隐私设置面板:读取、开关一拨就保存、失败退回、邮箱未验证提醒。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  callCapability: (...args: unknown[]) => callCapability(...args),
}))

import { CapabilityError } from '@/api/client'
import { useFriendsStore } from '@/stores/friends'
import { useSessionStore } from '@/stores/session'
import PrivacyPanel from './PrivacyPanel.vue'

const base = { searchable_by_email: false, searchable_by_username: true, share_from: 'everyone' }
const $ = <T extends Element = HTMLElement>(selector: string) => document.body.querySelector<T>(selector)
const on = (selector: string) => $(selector)!.getAttribute('aria-checked') === 'true'

let wrapper: VueWrapper | null = null
async function show(reply: unknown = { privacy: base }, emailVerified = true) {
  const session = useSessionStore()
  session.user = { id: 'u', username: 'alice', display_name: 'Alice', email: 'alice@example.com', email_verified: emailVerified, role_id: 'r', space_id: null, must_change_password: false }
  if (reply instanceof Error) callCapability.mockRejectedValueOnce(reply)
  else callCapability.mockResolvedValueOnce(reply)
  wrapper = mount(PrivacyPanel, { attachTo: document.body })
  await useFriendsStore().loadPrivacy()
  await flushPromises()
}

beforeEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  callCapability.mockReset()
  setActivePinia(createPinia())
})

describe('PrivacyPanel', () => {
  it('加载中:骨架屏;出错:原因 + 重新加载', async () => {
    wrapper = mount(PrivacyPanel, { attachTo: document.body })
    expect($('.kb-skel')).not.toBeNull()
    wrapper.unmount()
    await show(new CapabilityError('internal: x', 'internal', 500))
    expect($('[data-testid="privacy-error"]')!.textContent).toContain('没能加载隐私设置')
  })

  it('按后端返回显示:用户名可搜(开)、邮箱不可搜(关)、谁能分享给我=所有人', async () => {
    await show()
    expect(on('[data-testid="pv-username"]')).toBe(true)
    expect(on('[data-testid="pv-email"]')).toBe(false)
    expect($('[data-testid="pv-share"] .on')!.textContent!.trim()).toBe('所有人')
  })

  it('拨开邮箱开关:只发这一项,保存后开关为开', async () => {
    await show()
    callCapability.mockResolvedValueOnce({ privacy: { ...base, searchable_by_email: true } })
    $('[data-testid="pv-email"]')!.click()
    await flushPromises()
    expect(callCapability).toHaveBeenLastCalledWith('set_privacy', { searchable_by_email: true })
    expect(on('[data-testid="pv-email"]')).toBe(true)
  })

  it('改「谁可以把文档分享给我」为仅好友', async () => {
    await show()
    callCapability.mockResolvedValueOnce({ privacy: { ...base, share_from: 'friends' } })
    const friendsOnly = [...document.body.querySelectorAll<HTMLElement>('[data-testid="pv-share"] [role="tab"]')].find((tab) => tab.textContent!.includes('仅好友'))!
    friendsOnly.click()
    await flushPromises()
    expect(callCapability).toHaveBeenLastCalledWith('set_privacy', { share_from: 'friends' })
    expect($('[data-testid="pv-share"] .on')!.textContent!.trim()).toBe('仅好友')
  })

  it('保存失败:开关退回原样,原因写在下面不自动消失', async () => {
    await show()
    callCapability.mockRejectedValueOnce(new CapabilityError('internal: x', 'internal', 500))
    $('[data-testid="pv-username"]')!.click()
    await flushPromises()
    expect(on('[data-testid="pv-username"]')).toBe(true)
    expect($('[data-testid="privacy-save-error"]')!.textContent).toContain('没能保存隐私设置')
  })

  it('邮箱没验证:提醒「验证之前别人用邮箱也搜不到你」;验证了就不提醒', async () => {
    await show(undefined, false)
    expect($('[data-testid="pv-email-note"]')!.textContent).toContain('还没有验证')
    wrapper!.unmount()
    document.body.innerHTML = ''
    setActivePinia(createPinia())
    await show(undefined, true)
    expect($('[data-testid="pv-email-note"]')).toBeNull()
  })

  it('开关有读屏名字', async () => {
    await show()
    for (const id of ['pv-username', 'pv-email']) {
      const labelId = $(`[data-testid="${id}"]`)!.getAttribute('aria-labelledby')!
      expect(document.getElementById(labelId)!.textContent!.length).toBeGreaterThan(4)
    }
  })

  it('开关左边的文字也能点(触屏上开关太小):点文字等于拨开关', async () => {
    await show()
    callCapability.mockResolvedValueOnce({ privacy: { ...base, searchable_by_email: true } })
    $('[data-testid="pv-email-text"]')!.click()
    await flushPromises()
    expect(callCapability).toHaveBeenLastCalledWith('set_privacy', { searchable_by_email: true })
    callCapability.mockResolvedValueOnce({ privacy: { ...base, searchable_by_email: true, searchable_by_username: false } })
    $('[data-testid="pv-username-text"]')!.click()
    await flushPromises()
    expect(callCapability).toHaveBeenLastCalledWith('set_privacy', { searchable_by_username: false })
  })

  it('正在保存时再点不会并发发出第二个请求', async () => {
    await show()
    let release: (value: unknown) => void = () => undefined
    callCapability.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
    $('[data-testid="pv-email-text"]')!.click()
    $('[data-testid="pv-username-text"]')!.click()
    await flushPromises()
    expect(callCapability.mock.calls.filter((call) => call[0] === 'set_privacy')).toHaveLength(1)
    release({ privacy: { ...base, searchable_by_email: true } })
    await flushPromises()
  })
})
