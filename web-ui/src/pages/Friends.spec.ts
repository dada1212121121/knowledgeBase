// 好友页:没开通 / 加载 / 添加好友入口 / WebSocket 实时刷新。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { reactive } from 'vue'

const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  callCapability: (...args: unknown[]) => callCapability(...args),
}))
// 路由:页签记在 ?tab= 里;replace 时同步更新这里的 query,像真的路由一样
const route = reactive<{ query: Record<string, string> }>({ query: {} })
const replace = vi.fn(async (to: { query: Record<string, string> }) => {
  route.query = to.query
})
vi.mock('vue-router', () => ({ useRoute: () => route, useRouter: () => ({ replace }) }))
// 页面框架只负责把标题 / 操作传送进顶栏,与这里要测的无关
vi.mock('@/layouts/AppShell.vue', () => ({ default: { template: '<div class="app-shell"><slot /></div>' } }))
// 后端:按能力名回答(页面挂载时会同时请求好友和申请,顺序不固定)
let replies: Record<string, unknown> = {}
function backend(overrides: Record<string, unknown> = {}) {
  replies = { friend_list: { friends: [] }, friend_requests: { incoming: [], outgoing: [] }, ...overrides }
  callCapability.mockImplementation(async (name: string) => {
    const reply = replies[name]
    if (reply instanceof Error) throw reply
    return reply ?? {}
  })
}
// 抓住页面订阅的 WebSocket 回调,测试里手动推事件
let pushLive: (event: { type: string; data: Record<string, unknown> }) => void = () => undefined
vi.mock('@/composables/useLiveEvents', () => ({
  useLiveEvents: (listener: typeof pushLive) => {
    pushLive = listener
    return () => undefined
  },
}))

import { CapabilityError } from '@/api/client'
import { useSessionStore } from '@/stores/session'
import Friends from './Friends.vue'

const bob = { id: 'usr_bob', username: 'bob', display_name: 'Bob', avatar: null, remark: null, group_name: null, since: Date.now() }
const zhao = { id: 'usr_zhao', username: 'zhaoliu', display_name: '赵六', avatar: null }
const tabLabels = () => [...document.body.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent!.replace(/\s+/g, ''))
const $ = <T extends Element = HTMLElement>(selector: string) => document.body.querySelector<T>(selector)
const calls = (name: string) => callCapability.mock.calls.filter((call) => call[0] === name)

let wrapper: VueWrapper | null = null
function signIn(features: string[]) {
  const session = useSessionStore()
  session.user = { id: 'usr_me', username: 'alice', display_name: 'Alice', email: 'alice@example.com', role_id: 'r', space_id: null, must_change_password: false }
  session.features = new Set(features)
  session.loaded = true
}

beforeEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  callCapability.mockReset()
  replace.mockClear()
  route.query = {}
  setActivePinia(createPinia())
})

describe('Friends 页面', () => {
  it('账号没有 collab.friends:显示「没有开通」,不请求任何好友接口,也没有「添加好友」按钮', async () => {
    signIn(['docs.notes'])
    wrapper = mount(Friends, { attachTo: document.body })
    await flushPromises()
    expect($('[data-testid="friends-off"]')!.textContent).toContain('你的账号没有开通这个功能')
    expect($('[data-testid="friends-off"]')!.textContent).toContain('联系管理员')
    expect(callCapability).not.toHaveBeenCalled()
    expect($('[data-testid="friend-add"]')).toBeNull()
    expect($('[data-testid="friend-list"]')).toBeNull()
  })

  it('功能点在,但后端仍然 403(权限缓存还没刷新等):也显示「没有开通」', async () => {
    signIn(['collab.friends'])
    backend({ friend_list: new CapabilityError('forbidden', 'forbidden', 403), friend_requests: new CapabilityError('forbidden', 'forbidden', 403) })
    wrapper = mount(Friends, { attachTo: document.body })
    await flushPromises()
    expect($('[data-testid="friends-off"]')).not.toBeNull()
    expect($('[data-testid="friend-add"]')).toBeNull()
  })

  it('有功能点:载入好友列表,「添加好友」打开对话框', async () => {
    signIn(['collab.friends'])
    backend({ friend_list: { friends: [bob] } })
    wrapper = mount(Friends, { attachTo: document.body })
    await flushPromises()
    expect(calls('friend_list')).toHaveLength(1)
    expect(calls('friend_requests')).toHaveLength(1)
    expect($('[data-testid="friend-list"]')!.textContent).toContain('Bob')
    expect($('[data-testid="friends-off"]')).toBeNull()
    $<HTMLElement>('[data-testid="friend-add"]')!.click()
    await flushPromises()
    expect($('[data-testid="add-friend"]')).not.toBeNull()
  })

  it('功能表晚到(刷新页面时先按「有」处理):先不闪「没有开通」,到了以后按结果显示', async () => {
    const session = useSessionStore()
    // 还没加载完:has 一律返回 true,所以会先请求;这里模拟加载完发现其实没有
    backend()
    wrapper = mount(Friends, { attachTo: document.body })
    await flushPromises()
    expect($('[data-testid="friends-off"]')).toBeNull()
    session.features = new Set(['docs.notes'])
    session.loaded = true
    await flushPromises()
    expect($('[data-testid="friends-off"]')).not.toBeNull()
  })

  it('WebSocket 推来「好友申请结果」:好友和申请在后台静默刷新;别的通知不触发', async () => {
    signIn(['collab.friends'])
    backend()
    wrapper = mount(Friends, { attachTo: document.body })
    await flushPromises()
    expect($('[data-testid="friends-empty"]')).not.toBeNull()
    pushLive({ type: 'notify', data: { notification: { id: 9, kind: 'share_received', data: {} }, unread: 1 } })
    await flushPromises()
    expect(calls('friend_list')).toHaveLength(1)
    expect(calls('friend_requests')).toHaveLength(1)
    replies.friend_list = { friends: [bob] }
    pushLive({ type: 'notify', data: { notification: { id: 10, kind: 'friend_result', data: { accepted: true } }, unread: 2 } })
    await flushPromises()
    expect(calls('friend_list')).toHaveLength(2)
    expect(calls('friend_requests')).toHaveLength(2)
    expect($('[data-testid="friend-list"]')!.textContent).toContain('Bob')
  })

  it('WebSocket 推来「收到好友申请」:只刷新申请,页签上的数字跟着变', async () => {
    signIn(['collab.friends'])
    backend()
    wrapper = mount(Friends, { attachTo: document.body })
    await flushPromises()
    expect(tabLabels()).toEqual(['好友', '申请', '已拉黑', '隐私'])
    replies.friend_requests = { incoming: [{ id: 'frq_1', from: zhao, message: null, created_at: Date.now(), expires_at: Date.now() + 86_400_000 }], outgoing: [] }
    pushLive({ type: 'notify', data: { notification: { id: 11, kind: 'friend_request', data: {} }, unread: 1 } })
    await flushPromises()
    expect(calls('friend_list')).toHaveLength(1)
    expect(calls('friend_requests')).toHaveLength(2)
    expect(tabLabels()).toEqual(['好友', '申请1', '已拉黑', '隐私'])
  })

  it('页面没开通时收到通知也不去请求', async () => {
    signIn(['docs.notes'])
    wrapper = mount(Friends, { attachTo: document.body })
    await flushPromises()
    pushLive({ type: 'notify', data: { notification: { id: 10, kind: 'friend_result', data: {} }, unread: 1 } })
    await flushPromises()
    expect(callCapability).not.toHaveBeenCalled()
  })

  it('页签:默认「好友」;切到「申请」把页签写进地址;地址带 ?tab=requests 直接落在申请页签', async () => {
    signIn(['collab.friends'])
    backend()
    wrapper = mount(Friends, { attachTo: document.body })
    await flushPromises()
    expect($('[data-testid="friend-list"]')).not.toBeNull()
    expect($('[data-testid="friend-requests"]')).toBeNull()
    ;[...document.body.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.textContent!.includes('申请'))!.click()
    await flushPromises()
    expect(replace).toHaveBeenCalledWith({ query: { tab: 'requests' } })
    expect($('[data-testid="friend-requests"]')).not.toBeNull()
    expect($('[data-testid="friend-list"]')).toBeNull()
    // 已经在好友页时,从通知里点「好友申请」(地址变成 ?tab=requests 再变回去)页签跟着变
    route.query = {}
    await flushPromises()
    expect($('[data-testid="friend-list"]')).not.toBeNull()
    route.query = { tab: 'requests' }
    await flushPromises()
    expect($('[data-testid="friend-requests"]')).not.toBeNull()
  })

  it('刷新页面时地址里已经是 ?tab=requests:一开始就是申请页签', async () => {
    signIn(['collab.friends'])
    backend()
    route.query = { tab: 'requests' }
    wrapper = mount(Friends, { attachTo: document.body })
    await flushPromises()
    expect($('[data-testid="friend-requests"]')).not.toBeNull()
  })

  it('「已拉黑」「隐私」页签第一次打开时才取数据,再次切回来不重复取', async () => {
    signIn(['collab.friends'])
    backend({ block_list: { blocked: [] }, privacy_get: { privacy: { searchable_by_email: false, searchable_by_username: true, share_from: 'everyone' } } })
    wrapper = mount(Friends, { attachTo: document.body })
    await flushPromises()
    expect(calls('block_list')).toHaveLength(0)
    expect(calls('privacy_get')).toHaveLength(0)
    const open = async (label: string) => {
      ;[...document.body.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.textContent!.includes(label))!.click()
      await flushPromises()
    }
    await open('已拉黑')
    expect($('[data-testid="block-list"]')).not.toBeNull()
    expect(calls('block_list')).toHaveLength(1)
    await open('隐私')
    expect($('[data-testid="privacy-panel"]')).not.toBeNull()
    expect(calls('privacy_get')).toHaveLength(1)
    await open('已拉黑')
    expect(calls('block_list')).toHaveLength(1)
    expect(replace).toHaveBeenLastCalledWith({ query: { tab: 'blocked' } })
    await open('隐私')
    expect(calls('privacy_get')).toHaveLength(1)
  })

  it('地址里带 ?tab=privacy 直接落在隐私页签并取数据;不认识的 tab 值回到「好友」', async () => {
    signIn(['collab.friends'])
    backend({ privacy_get: { privacy: { searchable_by_email: false, searchable_by_username: true, share_from: 'everyone' } } })
    route.query = { tab: 'privacy' }
    wrapper = mount(Friends, { attachTo: document.body })
    await flushPromises()
    expect($('[data-testid="privacy-panel"]')).not.toBeNull()
    expect(calls('privacy_get')).toHaveLength(1)
    route.query = { tab: '乱写' }
    await flushPromises()
    expect($('[data-testid="friend-list"]')).not.toBeNull()
  })

  it('已拉黑页签上显示人数(取到数据之后)', async () => {
    signIn(['collab.friends'])
    backend({ block_list: { blocked: [{ user: zhao, since: 1 }, { user: { ...zhao, id: 'usr_x' }, since: 2 }] } })
    route.query = { tab: 'blocked' }
    wrapper = mount(Friends, { attachTo: document.body })
    await flushPromises()
    expect(tabLabels()).toEqual(['好友', '申请', '已拉黑2', '隐私'])
  })
})
