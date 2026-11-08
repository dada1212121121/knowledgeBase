// 个人设置里的通知偏好:四种状态、按分类列出、开关一拨就保存、失败退回、提醒邮件现在发不出去 / 邮箱没验证。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  callCapability: (...args: unknown[]) => callCapability(...args),
}))

import { CapabilityError } from '@/api/client'
import { useSessionStore } from '@/stores/session'
import { KIND_ORDER } from '@/utils/notifications'
import NotificationPrefs from './NotificationPrefs.vue'

// 与后端 kind::email_by_default 一致:需要马上知道并回应的默认发邮件
const DEFAULTS: Record<string, boolean> = Object.fromEntries(KIND_ORDER.map((kind) => [kind, ['friend_request', 'share_received', 'access_request', 'access_result', 'mention'].includes(kind)]))
const reply = (over: Record<string, unknown> = {}) => ({ email: { ...DEFAULTS }, kinds: [...KIND_ORDER], mail_available: true, ...over })
const $ = <T extends Element = HTMLElement>(selector: string) => document.body.querySelector<T>(selector)
const $$ = (selector: string) => [...document.body.querySelectorAll<HTMLElement>(selector)]
const on = (kind: string) => $(`[data-testid="np-${kind}"]`)!.getAttribute('aria-checked') === 'true'
const calls = () => callCapability.mock.calls.filter((call) => call[0] === 'notification_prefs')

let wrapper: VueWrapper | null = null
async function show(first: unknown = reply(), emailVerified = true) {
  const session = useSessionStore()
  session.user = { id: 'u', username: 'alice', display_name: 'Alice', email: 'alice@example.com', email_verified: emailVerified, role_id: 'r', space_id: null, must_change_password: false }
  if (first instanceof Error) callCapability.mockRejectedValueOnce(first)
  else callCapability.mockResolvedValueOnce(first)
  wrapper = mount(NotificationPrefs, { attachTo: document.body })
  await flushPromises()
}

beforeEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  callCapability.mockReset()
  setActivePinia(createPinia())
})

describe('状态', () => {
  it('加载中:骨架屏', () => {
    callCapability.mockReturnValueOnce(new Promise(() => undefined))
    wrapper = mount(NotificationPrefs, { attachTo: document.body })
    expect($('.kb-skel')).not.toBeNull()
  })

  it('出错:原因 + 重新加载,点了再取一次', async () => {
    await show(new CapabilityError('internal: x', 'internal', 500))
    expect($('[data-testid="np-error"]')!.textContent).toContain('没能加载通知偏好')
    callCapability.mockResolvedValueOnce(reply())
    $$('[data-testid="np-error"] button').find((button) => button.textContent!.includes('重新加载'))!.click()
    await flushPromises()
    expect($('[data-testid="np-error"]')).toBeNull()
    expect($('[data-testid="np-friend_request"]')).not.toBeNull()
  })

  it('响应残缺(缺字段)也不会让卡片崩溃', async () => {
    await show({})
    expect($('[data-testid="notify-prefs"]')).not.toBeNull()
    expect(on('friend_request')).toBe(false)
  })
})

describe('开关', () => {
  it('十种通知按分类(好友 / 分享 / 评论 / 系统)列出,开关状态照后端返回', async () => {
    await show()
    expect($$('.kb-np-h').map((el) => el.textContent)).toEqual(['好友', '分享', '评论', '系统'])
    expect($$('[role="switch"]')).toHaveLength(10)
    expect(on('friend_request')).toBe(true)
    expect(on('comment_reply')).toBe(false)
    expect(on('share_received')).toBe(true)
    expect(on('link_expiring')).toBe(false)
    const text = $('[data-testid="notify-prefs"]')!.textContent!
    for (const word of ['好友申请', '收到分享', '评论回复', '系统公告', '分享链接即将到期']) expect(text).toContain(word)
  })

  it('不提供「摘要频率」选项:只写明后端固定的合并规则', async () => {
    await show()
    const text = $('[data-testid="notify-prefs"]')!.textContent!
    expect(text).toContain('最多每 10 分钟收到一封')
    expect($('[data-testid="notify-prefs"] select')).toBeNull()
  })

  it('拨开关:只发这一类;完成后以服务端返回为准', async () => {
    await show()
    callCapability.mockResolvedValueOnce(reply({ email: { ...DEFAULTS, comment_reply: true } }))
    $('[data-testid="np-comment_reply"]')!.click()
    await flushPromises()
    expect(calls()[1]).toEqual(['notification_prefs', { email: { comment_reply: true } }])
    expect(on('comment_reply')).toBe(true)
  })

  it('保存期间开关已经是新值;期间别的开关不可点(一次一个请求)', async () => {
    await show()
    let release: (value: unknown) => void = () => undefined
    callCapability.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
    $('[data-testid="np-friend_request"]')!.click()
    await flushPromises()
    expect(on('friend_request')).toBe(false)
    expect($('[data-testid="np-mention"]')!.getAttribute('aria-disabled')).toBe('true')
    $('[data-testid="np-mention-text"]')!.click()
    await flushPromises()
    expect(calls()).toHaveLength(2)
    release(reply({ email: { ...DEFAULTS, friend_request: false } }))
    await flushPromises()
    expect(on('friend_request')).toBe(false)
  })

  it('点开关左边的文字也能切换', async () => {
    await show()
    callCapability.mockResolvedValueOnce(reply({ email: { ...DEFAULTS, announcement: true } }))
    $('[data-testid="np-announcement-text"]')!.click()
    await flushPromises()
    expect(calls()[1]).toEqual(['notification_prefs', { email: { announcement: true } }])
    expect(on('announcement')).toBe(true)
  })

  it('保存失败:开关退回原样,原因写在卡片里不自动消失', async () => {
    await show()
    callCapability.mockRejectedValueOnce(new CapabilityError('invalid input: 未知的通知种类 bogus', 'invalid_input', 400))
    $('[data-testid="np-mention"]')!.click()
    await flushPromises()
    expect(on('mention')).toBe(true)
    expect($('[data-testid="np-save-error"]')!.textContent).toContain('未知的通知种类')
    // 下一次成功的保存会清掉旧的错误
    callCapability.mockResolvedValueOnce(reply({ email: { ...DEFAULTS, mention: false } }))
    $('[data-testid="np-mention"]')!.click()
    await flushPromises()
    expect($('[data-testid="np-save-error"]')).toBeNull()
  })

  it('每个开关都有读屏名字(指向这一类的名字)', async () => {
    await show()
    for (const kind of KIND_ORDER) {
      const labelId = $(`[data-testid="np-${kind}"]`)!.getAttribute('aria-labelledby')!
      expect(document.getElementById(labelId)!.textContent!.length, kind).toBeGreaterThan(3)
    }
  })
})

describe('提醒', () => {
  it('站点没配发信:写明现在发不出去、选择会保存;配好了不提醒', async () => {
    await show(reply({ mail_available: false }))
    expect($('[data-testid="np-mail-off"]')!.textContent).toContain('现在选了也发不出去')
    expect($('[data-testid="np-mail-off"]')!.textContent).toContain('配置好以后生效')
    wrapper!.unmount()
    document.body.innerHTML = ''
    await show(reply({ mail_available: true }))
    expect($('[data-testid="np-mail-off"]')).toBeNull()
  })

  it('邮箱没验证:提醒验证之前不会收到邮件;验证了不提醒', async () => {
    await show(reply(), false)
    expect($('[data-testid="np-email-note"]')!.textContent).toContain('验证之前不会收到邮件')
    wrapper!.unmount()
    document.body.innerHTML = ''
    await show(reply(), true)
    expect($('[data-testid="np-email-note"]')).toBeNull()
  })
})
