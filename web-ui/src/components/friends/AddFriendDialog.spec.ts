// 添加好友对话框:搜索、结果、发申请、各种结果与错误。对话框被 Teleport 到 body,所以都从 document 里找。
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
import AddFriendDialog from './AddFriendDialog.vue'

const bob = { id: 'usr_bob', username: 'bob', display_name: 'Bob', avatar: null }
const $ = <T extends Element = HTMLElement>(selector: string) => document.body.querySelector<T>(selector)
const text = () => document.body.textContent ?? ''
const calls = (name: string) => callCapability.mock.calls.filter((call) => call[0] === name)

let wrapper: VueWrapper | null = null
function open() {
  wrapper = mount(AddFriendDialog, { attachTo: document.body })
  return wrapper
}
async function typeIn(selector: string, value: string) {
  const el = $<HTMLInputElement | HTMLTextAreaElement>(selector)!
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  await flushPromises()
}
async function click(selector: string) {
  $<HTMLElement>(selector)!.click()
  await flushPromises()
}
/** 先把搜索结果摆出来(后端按 `reply` 回答)。 */
async function searchFor(query: string, reply: unknown) {
  callCapability.mockResolvedValueOnce(reply)
  await typeIn('[data-testid="add-friend-query"]', query)
  await click('[data-testid="add-friend-search"]')
}

beforeEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  callCapability.mockReset()
  setActivePinia(createPinia())
  const session = useSessionStore()
  session.user = { id: 'usr_me', username: 'alice', display_name: 'Alice', email: 'alice@example.com', role_id: 'r', space_id: null, must_change_password: false }
  session.features = new Set(['collab.friends'])
  session.loaded = true
})

describe('搜索', () => {
  it('没输入时「搜索」不可点;输入后按完整查询(去掉首尾空白)调用 friend_search', async () => {
    open()
    expect($<HTMLButtonElement>('[data-testid="add-friend-search"]')!.disabled).toBe(true)
    await searchFor('  bob  ', { user: bob, relation: 'none' })
    expect(calls('friend_search')).toEqual([['friend_search', { query: 'bob' }]])
  })

  it('找到后只显示头像、昵称和用户名,不显示邮箱等别的东西', async () => {
    open()
    await searchFor('bob', { user: { ...bob, email: 'bob@example.com' }, relation: 'none' })
    const found = $('[data-testid="add-friend-found"]')!
    expect(found.textContent).toContain('Bob')
    expect(found.textContent).toContain('@bob')
    expect(text()).not.toContain('bob@example.com')
  })

  it('找不到:只写一句话,不透露原因(没这个人、对方不允许被搜到、被拉黑,后端结果完全一样)', async () => {
    open()
    await searchFor('nobody', { user: null, relation: 'none' })
    const note = $('[data-testid="add-friend-notfound"]')!
    expect(note.textContent).toContain('没有找到这个用户')
    expect(note.textContent).not.toMatch(/拉黑|屏蔽/)
    expect($('[data-testid="add-friend-send"]')).toBeNull()
  })

  it('搜自己的用户名或邮箱:不发请求,直接说明', async () => {
    open()
    await typeIn('[data-testid="add-friend-query"]', 'Alice@Example.com')
    await click('[data-testid="add-friend-search"]')
    expect(callCapability).not.toHaveBeenCalled()
    expect(text()).toContain('这是你自己的账号')
  })

  it('搜索太频繁(后端 503):把后端的中文原因显示在输入框下面', async () => {
    open()
    callCapability.mockRejectedValueOnce(new CapabilityError('unavailable: 搜索太频繁了,请一分钟后再试', 'unavailable', 503))
    await typeIn('[data-testid="add-friend-query"]', 'bob')
    await click('[data-testid="add-friend-search"]')
    const alert = document.body.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('搜索太频繁了,请一分钟后再试')
    // 失败后还能再搜
    expect($<HTMLButtonElement>('[data-testid="add-friend-search"]')!.disabled).toBe(false)
  })

  it('回车触发搜索,但中文输入法组字时的回车不算', async () => {
    open()
    callCapability.mockResolvedValue({ user: bob, relation: 'none' })
    await typeIn('[data-testid="add-friend-query"]', 'bob')
    const input = $<HTMLInputElement>('[data-testid="add-friend-query"]')!
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true }))
    await flushPromises()
    expect(callCapability).not.toHaveBeenCalled()
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await flushPromises()
    expect(calls('friend_search')).toHaveLength(1)
  })

  it('改了要找的人,上一次的结果立刻作废(不会对着旧结果的人发申请)', async () => {
    open()
    await searchFor('bob', { user: bob, relation: 'none' })
    expect($('[data-testid="add-friend-found"]')).not.toBeNull()
    await typeIn('[data-testid="add-friend-query"]', 'carol')
    expect($('[data-testid="add-friend-found"]')).toBeNull()
    expect($('[data-testid="add-friend-send"]')).toBeNull()
  })
})

describe('发申请', () => {
  it('带附言发出:参数是对方 id 和去掉空白的附言;成功后显示结果并通知父组件', async () => {
    const wrap = open()
    await searchFor('bob', { user: bob, relation: 'none' })
    await typeIn('[data-testid="add-friend-note"]', ' 我是上周的同事 ')
    callCapability.mockResolvedValueOnce({ status: 'requested' })
    await click('[data-testid="add-friend-send"]')
    expect(calls('friend_request')).toEqual([['friend_request', { user_id: 'usr_bob', message: '我是上周的同事' }]])
    expect($('[data-testid="add-friend-done"]')!.textContent).toContain('申请已发送')
    expect(wrap.emitted('sent')).toEqual([['requested']])
  })

  it('不写附言就不带 message 字段', async () => {
    open()
    await searchFor('bob', { user: bob, relation: 'none' })
    callCapability.mockResolvedValueOnce({ status: 'requested' })
    await click('[data-testid="add-friend-send"]')
    expect(calls('friend_request')[0]![1]).toEqual({ user_id: 'usr_bob' })
  })

  it('附言超过 100 个字:提示并且不能发送', async () => {
    open()
    await searchFor('bob', { user: bob, relation: 'none' })
    await typeIn('[data-testid="add-friend-note"]', '字'.repeat(101))
    expect(text()).toContain('附言最多 100 个字')
    expect($<HTMLButtonElement>('[data-testid="add-friend-send"]')!.disabled).toBe(true)
    await typeIn('[data-testid="add-friend-note"]', '字'.repeat(100))
    expect($<HTMLButtonElement>('[data-testid="add-friend-send"]')!.disabled).toBe(false)
  })

  it('已经是好友 / 已发过申请:只说明情况,不给发送按钮', async () => {
    open()
    await searchFor('bob', { user: bob, relation: 'friend' })
    expect($('[data-testid="add-friend-state"]')!.textContent).toContain('已经是好友')
    expect($('[data-testid="add-friend-send"]')).toBeNull()
    await typeIn('[data-testid="add-friend-query"]', 'bobby')
    await searchFor('bobby', { user: bob, relation: 'pending_out' })
    expect($('[data-testid="add-friend-state"]')!.textContent).toContain('请等对方处理')
    expect($('[data-testid="add-friend-send"]')).toBeNull()
  })

  it('对方已经向我申请过:按钮是「同意并加为好友」,不要求附言;结果是「friends」时通知父组件刷新列表', async () => {
    const wrap = open()
    await searchFor('bob', { user: bob, relation: 'pending_in' })
    expect($('[data-testid="add-friend-note"]')).toBeNull()
    expect($('[data-testid="add-friend-send"]')!.textContent).toContain('同意并加为好友')
    callCapability.mockResolvedValueOnce({ status: 'friends' })
    await click('[data-testid="add-friend-send"]')
    expect(wrap.emitted('sent')).toEqual([['friends']])
    expect($('[data-testid="add-friend-done"]')!.textContent).toContain('已经是好友')
  })

  it('被拉黑时后端也返回 requested:界面照实显示「已发送」,不去核对', async () => {
    open()
    await searchFor('carol', { user: { ...bob, id: 'usr_carol', username: 'carol', display_name: 'Carol' }, relation: 'none' })
    callCapability.mockResolvedValueOnce({ status: 'requested' })
    await click('[data-testid="add-friend-send"]')
    expect($('[data-testid="add-friend-done"]')!.textContent).toContain('申请已发送')
    // 除了搜索和发申请,不再多问一次后端(比如去翻对方的列表)
    expect(callCapability).toHaveBeenCalledTimes(2)
  })

  it('发送失败(24 小时内被拒绝过):后端原因显示在面板里,可以改了再试', async () => {
    open()
    await searchFor('bob', { user: bob, relation: 'none' })
    callCapability.mockRejectedValueOnce(new CapabilityError('forbidden: 你刚刚向这位用户申请过,请 24 小时后再试', 'forbidden', 403))
    await click('[data-testid="add-friend-send"]')
    expect($('[data-testid="add-friend-found"]')!.textContent).toContain('请 24 小时后再试')
    expect($('[data-testid="add-friend-done"]')).toBeNull()
    expect($<HTMLButtonElement>('[data-testid="add-friend-send"]')!.disabled).toBe(false)
  })

  it('发完后「继续添加」回到空白的搜索框', async () => {
    open()
    await searchFor('bob', { user: bob, relation: 'none' })
    callCapability.mockResolvedValueOnce({ status: 'already_pending' })
    await click('[data-testid="add-friend-send"]')
    expect($('[data-testid="add-friend-done"]')!.textContent).toContain('已经向对方发过申请')
    const again = [...document.body.querySelectorAll('button')].find((button) => button.textContent?.trim() === '继续添加')!
    again.click()
    await flushPromises()
    expect($<HTMLInputElement>('[data-testid="add-friend-query"]')!.value).toBe('')
    expect($('[data-testid="add-friend-done"]')).toBeNull()
  })
})
