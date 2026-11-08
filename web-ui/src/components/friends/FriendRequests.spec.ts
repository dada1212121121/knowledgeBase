// 好友申请面板:四种状态、通过 / 拒绝(带确认)/ 忽略、失败提示、发出的申请。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  callCapability: (...args: unknown[]) => callCapability(...args),
}))
const ask = vi.fn()
vi.mock('@kb-ui/index', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kb-ui/index')>()),
  useConfirm: () => ({ ask }),
}))

import { CapabilityError } from '@/api/client'
import type { IncomingRequest, OutgoingRequest } from '@/api/social'
import { useFriendsStore } from '@/stores/friends'
import FriendRequests from './FriendRequests.vue'

const NOW = Date.now()
const profile = (id: string, name: string) => ({ id: `usr_${id}`, username: id, display_name: name, avatar: null })
const incomingRow = (id: string, from: string, message: string | null = null): IncomingRequest => ({
  id,
  from: profile(from, from.toUpperCase()),
  message,
  created_at: NOW - 20 * 60_000,
  expires_at: NOW + 5 * 86_400_000,
})
const outgoingRow = (id: string, to: string): OutgoingRequest => ({ id, to: profile(to, to.toUpperCase()), message: '你好', created_at: NOW - 86_400_000, expires_at: NOW + 6 * 86_400_000 })
const $ = <T extends Element = HTMLElement>(selector: string) => document.body.querySelector<T>(selector)
const $$ = (selector: string) => [...document.body.querySelectorAll<HTMLElement>(selector)]
const calls = (name: string) => callCapability.mock.calls.filter((call) => call[0] === name)

let wrapper: VueWrapper | null = null
async function show(reply: { incoming: IncomingRequest[]; outgoing: OutgoingRequest[] } | Error) {
  if (reply instanceof Error) callCapability.mockRejectedValueOnce(reply)
  else callCapability.mockResolvedValueOnce(reply)
  wrapper = mount(FriendRequests, { attachTo: document.body })
  await useFriendsStore().loadRequests()
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  callCapability.mockReset()
  ask.mockReset()
  setActivePinia(createPinia())
})

describe('四种状态', () => {
  it('加载中:骨架屏', () => {
    wrapper = mount(FriendRequests, { attachTo: document.body })
    expect($('.kb-skel')).not.toBeNull()
  })

  it('空:说明 + 「添加好友」(点它通知页面)', async () => {
    const wrap = await show({ incoming: [], outgoing: [] })
    expect($('[data-testid="requests-empty"]')!.textContent).toContain('没有待处理的好友申请')
    $$('[data-testid="requests-empty"] button').find((button) => button.textContent?.trim() === '添加好友')!.click()
    expect(wrap.emitted('add')).toHaveLength(1)
  })

  it('出错:原因 + 重新加载', async () => {
    await show(new CapabilityError('internal: x', 'internal', 500))
    expect($('[data-testid="requests-error"]')!.textContent).toContain('没能加载好友申请')
    callCapability.mockResolvedValueOnce({ incoming: [incomingRow('frq_1', 'zhao')], outgoing: [] })
    $$('[data-testid="requests-error"] button').find((button) => button.textContent?.trim() === '重新加载')!.click()
    await flushPromises()
    expect($$('[data-testid="request-in"]')).toHaveLength(1)
  })

  it('只有发出的:收到的一栏写「现在没有人在等你处理」,发出的照常列出', async () => {
    await show({ incoming: [], outgoing: [outgoingRow('frq_2', 'erin')] })
    expect($('[data-testid="requests-none-in"]')!.textContent).toContain('没有人在等你处理')
    expect($$('[data-testid="request-out"]')).toHaveLength(1)
    expect($('[data-testid="request-out"]')!.textContent).toContain('等待对方处理')
    expect($('[data-testid="request-out"]')!.textContent).toContain('天后过期')
  })
})

describe('收到的申请', () => {
  it('显示名字、@用户名、附言、时间和过期;附言当文本显示,不会被当成 HTML', async () => {
    await show({ incoming: [incomingRow('frq_1', 'zhao', '<img src=x onerror=alert(1)>我是同事')], outgoing: [] })
    const row = $('[data-testid="request-in"]')!
    expect(row.textContent).toContain('ZHAO')
    expect(row.textContent).toContain('@zhao')
    expect(row.textContent).toContain('<img src=x onerror=alert(1)>我是同事')
    expect(row.querySelector('img')).toBeNull()
    expect(row.textContent).toContain('20 分钟前')
    expect(row.textContent).toContain('5 天后过期')
  })

  it('通过:发 accept,这一行消失,并提示成为好友', async () => {
    await show({ incoming: [incomingRow('frq_1', 'zhao'), incomingRow('frq_2', 'qian')], outgoing: [] })
    callCapability.mockResolvedValue({ state: 'accepted', friends: [] })
    $$('[data-testid="request-accept"]')[0]!.click()
    await flushPromises()
    expect(calls('friend_decide')).toEqual([['friend_decide', { id: 'frq_1', decision: 'accept' }]])
    expect($$('[data-testid="request-in"]')).toHaveLength(1)
    expect($('[data-testid="request-in"]')!.textContent).toContain('QIAN')
  })

  it('忽略:发 ignore,不弹确认', async () => {
    await show({ incoming: [incomingRow('frq_1', 'zhao')], outgoing: [] })
    callCapability.mockResolvedValue({ state: 'ignored' })
    $('[data-testid="request-ignore"]')!.click()
    await flushPromises()
    expect(ask).not.toHaveBeenCalled()
    expect(calls('friend_decide')).toEqual([['friend_decide', { id: 'frq_1', decision: 'ignore' }]])
  })

  it('拒绝:先确认(写明会通知对方、24 小时内不能再申请);取消就什么都不发', async () => {
    await show({ incoming: [incomingRow('frq_1', 'zhao')], outgoing: [] })
    ask.mockResolvedValueOnce(false)
    $('[data-testid="request-reject"]')!.click()
    await flushPromises()
    expect(ask.mock.calls[0]![0].message).toContain('24 小时内不能再向你申请')
    expect(ask.mock.calls[0]![0].message).toContain('忽略')
    expect(calls('friend_decide')).toHaveLength(0)
    expect($$('[data-testid="request-in"]')).toHaveLength(1)
    ask.mockResolvedValueOnce(true)
    callCapability.mockResolvedValue({ state: 'rejected' })
    $('[data-testid="request-reject"]')!.click()
    await flushPromises()
    expect(calls('friend_decide')).toEqual([['friend_decide', { id: 'frq_1', decision: 'reject' }]])
    expect($$('[data-testid="request-in"]')).toHaveLength(0)
  })

  it('这条申请已在别处处理过(404):提示并刷新列表,不是一句英文报错', async () => {
    await show({ incoming: [incomingRow('frq_1', 'zhao')], outgoing: [] })
    callCapability.mockRejectedValueOnce(new CapabilityError('not found: 没有这条好友申请', 'not_found', 404))
    callCapability.mockResolvedValueOnce({ incoming: [], outgoing: [] })
    $('[data-testid="request-accept"]')!.click()
    await flushPromises()
    expect($('[data-testid="request-error"]')!.textContent).toBe('这条申请已经处理过或已过期,列表已更新。')
    expect($$('[data-testid="request-in"]')).toHaveLength(0)
  })

  it('好友数达到上限:后端的中文原因原样显示,申请还在,可以再试', async () => {
    await show({ incoming: [incomingRow('frq_1', 'zhao')], outgoing: [] })
    callCapability.mockRejectedValueOnce(new CapabilityError('invalid input: 你的好友数已达上限', 'invalid_input', 400))
    $('[data-testid="request-accept"]')!.click()
    await flushPromises()
    expect($('[data-testid="request-error"]')!.textContent).toContain('你的好友数已达上限')
    expect($$('[data-testid="request-in"]')).toHaveLength(1)
    expect($<HTMLButtonElement>('[data-testid="request-accept"]')!.disabled).toBe(false)
  })

  it('按钮的读屏名字带上对方是谁', async () => {
    await show({ incoming: [incomingRow('frq_1', 'zhao')], outgoing: [] })
    expect($('[data-testid="request-accept"]')!.getAttribute('aria-label')).toBe('通过ZHAO的好友申请')
    expect($('[data-testid="request-reject"]')!.getAttribute('aria-label')).toBe('拒绝ZHAO的好友申请')
    expect($('[data-testid="request-ignore"]')!.getAttribute('aria-label')).toBe('忽略ZHAO的好友申请')
  })

  it('拉黑骚扰的申请人:先确认,确认后发 block,这条申请随之消失', async () => {
    await show({ incoming: [incomingRow('frq_1', 'zhao')], outgoing: [] })
    callCapability.mockImplementation(async (name: string) => {
      if (name === 'friend_requests') return { incoming: [], outgoing: [] }
      if (name === 'friend_list') return { friends: [] }
      if (name === 'block_list') return { blocked: [] }
      return { blocked: true }
    })
    ask.mockImplementationOnce(async (options: { action: () => Promise<unknown> }) => {
      await options.action()
      return true
    })
    $('[data-testid="request-block"]')!.click()
    await flushPromises()
    expect(ask.mock.calls[0]![0].title).toBe('拉黑ZHAO?')
    expect(calls('block')).toEqual([['block', { user_id: 'usr_zhao' }]])
    expect($$('[data-testid="request-in"]')).toHaveLength(0)
  })

  it('拉黑取消确认:不发请求,申请还在', async () => {
    await show({ incoming: [incomingRow('frq_1', 'zhao')], outgoing: [] })
    ask.mockResolvedValueOnce(false)
    $('[data-testid="request-block"]')!.click()
    await flushPromises()
    expect(calls('block')).toHaveLength(0)
    expect($$('[data-testid="request-in"]')).toHaveLength(1)
  })
})
