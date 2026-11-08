// 好友列表 + 详情面板:四种状态、搜索、改备注 / 分组、删除确认。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  callCapability: (...args: unknown[]) => callCapability(...args),
}))
// 确认弹窗的宿主在外壳里,这里只关心「弹了什么、点了确认之后会发生什么」
const ask = vi.fn()
vi.mock('@kb-ui/index', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kb-ui/index')>()),
  useConfirm: () => ({ ask }),
}))

import { CapabilityError } from '@/api/client'
import type { Friend } from '@/api/social'
import { useFriendsStore } from '@/stores/friends'
import FriendList from './FriendList.vue'

const friend = (id: string, name: string, over: Partial<Friend> = {}): Friend => ({
  id: `usr_${id}`,
  username: id,
  display_name: name,
  avatar: null,
  remark: null,
  group_name: null,
  since: Date.now() - 5 * 60_000,
  ...over,
})
const $ = <T extends Element = HTMLElement>(selector: string) => document.body.querySelector<T>(selector)
const calls = (name: string) => callCapability.mock.calls.filter((call) => call[0] === name)

let wrapper: VueWrapper | null = null
async function show(friends: Friend[] | Error) {
  if (friends instanceof Error) callCapability.mockRejectedValueOnce(friends)
  else callCapability.mockResolvedValueOnce({ friends })
  wrapper = mount(FriendList, { attachTo: document.body })
  await useFriendsStore().loadFriends()
  await flushPromises()
  return wrapper
}
async function setValue(selector: string, value: string) {
  const el = $<HTMLInputElement>(selector)!
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  await flushPromises()
}
const names = () => [...document.body.querySelectorAll('[data-testid="rt-row"] b')].map((el) => el.textContent)

beforeEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  callCapability.mockReset()
  ask.mockReset()
  setActivePinia(createPinia())
})

describe('四种状态', () => {
  it('加载中:显示骨架屏,不显示空状态', async () => {
    wrapper = mount(FriendList, { attachTo: document.body })
    expect($('.kb-skel')).not.toBeNull()
    expect($('[data-testid="friends-empty"]')).toBeNull()
  })

  it('空:说明现在是什么情况,并给「添加好友」按钮(点它通知页面打开添加对话框)', async () => {
    const wrap = await show([])
    const empty = $('[data-testid="friends-empty"]')!
    expect(empty.textContent).toContain('还没有好友')
    const add = [...empty.querySelectorAll('button')].find((button) => button.textContent?.trim() === '添加好友')!
    add.click()
    expect(wrap.emitted('add')).toHaveLength(1)
  })

  it('出错:显示原因和「重新加载」,点了会再请求一次', async () => {
    await show(new CapabilityError('internal: x', 'internal', 500))
    const error = $('[data-testid="friends-error"]')!
    expect(error.textContent).toContain('没能加载好友列表')
    expect(error.textContent).toContain('请检查网络后重试')
    callCapability.mockResolvedValueOnce({ friends: [friend('bob', 'Bob')] })
    ;[...error.querySelectorAll('button')].find((button) => button.textContent?.trim() === '重新加载')!.click()
    await flushPromises()
    expect($('[data-testid="friends-error"]')).toBeNull()
    expect(names()).toEqual(['Bob'])
  })

  it('有数据:显示好友名、@用户名、分组、人数', async () => {
    await show([friend('bob', 'Bob', { remark: '老 b', group_name: '同事' }), friend('carol', 'Carol')])
    expect($('[data-testid="friend-count"]')!.textContent).toContain('共 2 位好友')
    const text = document.body.textContent!
    expect(text).toContain('老 b')
    expect(text).toContain('Bob(@bob)')
    expect(text).toContain('同事')
    expect(text).toContain('未分组')
    // 「加好友时间」列用相对时间(具体写法见 utils/social.spec.ts)
    expect(text).toContain('5 分钟前')
  })
})

describe('搜索', () => {
  it('按备注 / 昵称 / 用户名 / 分组过滤;没有匹配时给「清除搜索」', async () => {
    await show([friend('bob', 'Bob', { remark: '产品部小林', group_name: '同事' }), friend('carol', 'Carol', { group_name: '家人' })])
    await setValue('[data-testid="friend-filter"]', '小林')
    expect(names()).toEqual(['产品部小林'])
    await setValue('[data-testid="friend-filter"]', '家人')
    expect(names()).toEqual(['Carol'])
    await setValue('[data-testid="friend-filter"]', 'zzz')
    expect(names()).toEqual([])
    expect(document.body.textContent).toContain('没有符合「zzz」的好友')
    ;[...document.body.querySelectorAll('button')].find((button) => button.textContent?.trim() === '清除搜索')!.click()
    await flushPromises()
    expect(names()).toHaveLength(2)
  })
})

describe('详情面板', () => {
  async function openBob() {
    await show([friend('bob', 'Bob', { remark: '老 b', group_name: '同事' }), friend('carol', 'Carol', { group_name: '家人' })])
    ;[...document.body.querySelectorAll<HTMLElement>('[data-testid="rt-row"]')].find((row) => row.textContent!.includes('Bob'))!.click()
    await flushPromises()
    expect($('[data-testid="friend-manage"]')).not.toBeNull()
  }

  it('点一行打开面板,带出当前备注和分组;没改动时「保存」不可点', async () => {
    await openBob()
    const inputs = document.body.querySelectorAll<HTMLInputElement>('[data-testid="friend-manage"] input')
    expect(inputs[0]!.value).toBe('老 b')
    expect(inputs[1]!.value).toBe('同事')
    expect($<HTMLButtonElement>('[data-testid="friend-save"]')!.disabled).toBe(true)
  })

  it('改备注保存:调用 friend_update,列表立刻变,面板关闭', async () => {
    await openBob()
    const [remark] = document.body.querySelectorAll<HTMLInputElement>('[data-testid="friend-manage"] input')
    remark!.value = '阿 b'
    remark!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    callCapability.mockResolvedValueOnce({ updated: true })
    $<HTMLButtonElement>('[data-testid="friend-save"]')!.click()
    await flushPromises()
    expect(calls('friend_update')).toEqual([['friend_update', { friend_id: 'usr_bob', remark: '阿 b', group_name: '同事' }]])
    expect($('[data-testid="friend-manage"]')).toBeNull()
    expect(names()).toContain('阿 b')
  })

  it('清空备注 = 清除(发 null)', async () => {
    await openBob()
    const [remark] = document.body.querySelectorAll<HTMLInputElement>('[data-testid="friend-manage"] input')
    remark!.value = ''
    remark!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    callCapability.mockResolvedValueOnce({ updated: true })
    $<HTMLButtonElement>('[data-testid="friend-save"]')!.click()
    await flushPromises()
    expect(calls('friend_update')[0]![1]).toEqual({ friend_id: 'usr_bob', remark: null, group_name: '同事' })
  })

  it('备注超过 30 个字:就近提示,不能保存', async () => {
    await openBob()
    const [remark] = document.body.querySelectorAll<HTMLInputElement>('[data-testid="friend-manage"] input')
    remark!.value = '字'.repeat(31)
    remark!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    expect($('[data-testid="friend-manage"]')!.textContent).toContain('备注名最多 30 个字')
    expect($<HTMLButtonElement>('[data-testid="friend-save"]')!.disabled).toBe(true)
  })

  it('保存失败:原因显示在面板里,面板不关,可以再试', async () => {
    await openBob()
    const [remark] = document.body.querySelectorAll<HTMLInputElement>('[data-testid="friend-manage"] input')
    remark!.value = '新的'
    remark!.dispatchEvent(new Event('input', { bubbles: true }))
    await flushPromises()
    callCapability.mockRejectedValueOnce(new CapabilityError('not found: 他不是你的好友', 'not_found', 404))
    $<HTMLButtonElement>('[data-testid="friend-save"]')!.click()
    await flushPromises()
    expect($('[data-testid="friend-manage"]')!.textContent).toContain('他不是你的好友')
    expect($('[data-testid="friend-manage"]')).not.toBeNull()
    expect($<HTMLButtonElement>('[data-testid="friend-save"]')!.disabled).toBe(false)
  })

  it('删除好友:先弹确认(写明后果:不收回分享、要重新申请),确认后才调用 friend_remove,并关闭面板', async () => {
    await openBob()
    ask.mockImplementationOnce(async (options: { action: () => Promise<unknown> }) => {
      await options.action()
      return true
    })
    callCapability.mockResolvedValueOnce({ removed: true })
    $<HTMLElement>('[data-testid="friend-remove"]')!.click()
    await flushPromises()
    const options = ask.mock.calls[0]![0]
    expect(options.title).toContain('老 b')
    expect(options.tone).toBe('danger')
    expect(options.message).toContain('不会被收回')
    expect(options.message).toContain('重新发好友申请')
    expect(calls('friend_remove')).toEqual([['friend_remove', { user_id: 'usr_bob' }]])
    expect(names()).toEqual(['Carol'])
    expect($('[data-testid="friend-manage"]')).toBeNull()
  })

  it('在确认弹窗里点了取消:什么都不发生', async () => {
    await openBob()
    ask.mockResolvedValueOnce(false)
    $<HTMLElement>('[data-testid="friend-remove"]')!.click()
    await flushPromises()
    expect(calls('friend_remove')).toHaveLength(0)
    expect($('[data-testid="friend-manage"]')).not.toBeNull()
    expect(names()).toHaveLength(2)
  })

  it('拉黑:确认里写明后果(解除好友、对方不会收到通知),确认后发 block 并刷新好友、申请、拉黑名单,面板关闭', async () => {
    await openBob()
    callCapability.mockImplementation(async (name: string) => {
      if (name === 'friend_list') return { friends: [friend('carol', 'Carol', { group_name: '家人' })] }
      if (name === 'friend_requests') return { incoming: [], outgoing: [] }
      if (name === 'block_list') return { blocked: [] }
      return { blocked: true }
    })
    ask.mockImplementationOnce(async (options: { action: () => Promise<unknown> }) => {
      await options.action()
      return true
    })
    $<HTMLElement>('[data-testid="friend-block"]')!.click()
    await flushPromises()
    const options = ask.mock.calls[0]![0]
    expect(options.title).toBe('拉黑老 b?')
    expect(options.tone).toBe('danger')
    expect(options.message).toContain('不再是好友')
    expect(options.message).toContain('对方不会收到任何通知')
    expect(options.message).toContain('已经分享的内容不受影响')
    expect(calls('block')).toEqual([['block', { user_id: 'usr_bob' }]])
    expect(calls('friend_list').length).toBeGreaterThan(1)
    expect(calls('friend_requests')).toHaveLength(1)
    expect(calls('block_list')).toHaveLength(1)
    expect(names()).toEqual(['Carol'])
    expect($('[data-testid="friend-manage"]')).toBeNull()
  })

  it('拉黑时取消确认:什么都不发生', async () => {
    await openBob()
    ask.mockResolvedValueOnce(false)
    $<HTMLElement>('[data-testid="friend-block"]')!.click()
    await flushPromises()
    expect(calls('block')).toHaveLength(0)
    expect($('[data-testid="friend-manage"]')).not.toBeNull()
  })
})
