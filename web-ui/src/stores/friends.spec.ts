// 好友 store:列表加载 / 失败 / 没开通、静默刷新、旧响应不覆盖新数据、改备注、删除。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

const callCapability = vi.fn()
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  callCapability: (...args: unknown[]) => callCapability(...args),
}))

import { CapabilityError } from '@/api/client'
import type { Friend, IncomingRequest, OutgoingRequest } from '@/api/social'
import { useFriendsStore } from './friends'

const friend = (id: string, name: string, over: Partial<Friend> = {}): Friend => ({
  id,
  username: id,
  display_name: name,
  avatar: null,
  remark: null,
  group_name: null,
  since: 1000,
  ...over,
})

beforeEach(() => {
  callCapability.mockReset()
  setActivePinia(createPinia())
})

describe('loadFriends', () => {
  it('拉回来的好友按显示名排好序,状态变 ready', async () => {
    callCapability.mockResolvedValue({ friends: [friend('c', '王五'), friend('a', 'Alice')] })
    const store = useFriendsStore()
    expect(store.friendsStatus).toBe('idle')
    await store.loadFriends()
    expect(callCapability).toHaveBeenCalledWith('friend_list', {})
    expect(store.friends.map((item) => item.id)).toEqual(['a', 'c'])
    expect(store.friendsStatus).toBe('ready')
    expect(store.forbidden).toBe(false)
  })

  it('失败:状态变 error,错误写成人话;重试成功后恢复', async () => {
    callCapability.mockRejectedValueOnce(new CapabilityError('internal: sqlite busy', 'internal', 500))
    const store = useFriendsStore()
    await store.loadFriends()
    expect(store.friendsStatus).toBe('error')
    expect(store.friendsError).toBe('没能加载好友列表。请检查网络后重试。')
    expect(store.forbidden).toBe(false)
    callCapability.mockResolvedValueOnce({ friends: [friend('a', 'Alice')] })
    await store.loadFriends()
    expect(store.friendsStatus).toBe('ready')
    expect(store.friendsError).toBe('')
  })

  it('后端对好友能力返回 403(功能点被关):标记 forbidden', async () => {
    callCapability.mockRejectedValue(new CapabilityError('forbidden: 没有权限', 'forbidden', 403))
    const store = useFriendsStore()
    await store.loadFriends()
    expect(store.forbidden).toBe(true)
    expect(store.friendsStatus).toBe('error')
  })

  it('404 同样算没开通(e2e_social.rs:功能点被关时 403 或 404)', async () => {
    callCapability.mockRejectedValue(new CapabilityError('not found', 'not_found', 404))
    const store = useFriendsStore()
    await store.loadFriends()
    expect(store.forbidden).toBe(true)
  })

  it('静默刷新:已有数据时状态不退回 loading(不闪骨架屏),失败也不改动现有列表', async () => {
    callCapability.mockResolvedValueOnce({ friends: [friend('a', 'Alice')] })
    const store = useFriendsStore()
    await store.loadFriends()
    const seen: string[] = []
    callCapability.mockImplementationOnce(async () => {
      seen.push(store.friendsStatus)
      return { friends: [friend('a', 'Alice'), friend('b', 'Bob')] }
    })
    await store.loadFriends({ silent: true })
    expect(seen).toEqual(['ready'])
    expect(store.friends).toHaveLength(2)
    callCapability.mockRejectedValueOnce(new Error('offline'))
    await store.loadFriends({ silent: true })
    expect(store.friendsStatus).toBe('ready')
    expect(store.friends).toHaveLength(2)
    expect(store.friendsError).toBe('')
  })

  it('没数据时的「静默」刷新照样显示加载中(否则页面是一片空白)', async () => {
    const store = useFriendsStore()
    let status = ''
    callCapability.mockImplementationOnce(async () => {
      status = store.friendsStatus
      return { friends: [] }
    })
    await store.loadFriends({ silent: true })
    expect(status).toBe('loading')
  })

  it('两次加载并发:只认最后发出的那一次,旧响应晚到也不会盖掉新数据', async () => {
    let releaseFirst: (value: unknown) => void = () => undefined
    callCapability.mockImplementationOnce(() => new Promise((resolve) => (releaseFirst = resolve)))
    callCapability.mockResolvedValueOnce({ friends: [friend('new', '新的')] })
    const store = useFriendsStore()
    const first = store.loadFriends()
    await store.loadFriends()
    releaseFirst({ friends: [friend('old', '旧的')] })
    await first
    expect(store.friends.map((item) => item.id)).toEqual(['new'])
  })
})

describe('updateFriend', () => {
  it('空白当作清除(传 null),并更新本地列表、重新排序', async () => {
    callCapability.mockResolvedValueOnce({ friends: [friend('a', 'Alice', { remark: '甲' }), friend('b', 'Bob')] })
    const store = useFriendsStore()
    await store.loadFriends()
    callCapability.mockResolvedValueOnce({ updated: true })
    await store.updateFriend('a', { remark: '   ', group_name: ' 同事 ' })
    expect(callCapability).toHaveBeenLastCalledWith('friend_update', { friend_id: 'a', remark: null, group_name: '同事' })
    const alice = store.friends.find((item) => item.id === 'a')!
    expect(alice.remark).toBeNull()
    expect(alice.group_name).toBe('同事')
    expect(store.friends.map((item) => item.id)).toEqual(['a', 'b'])
  })

  it('失败时抛出错误,本地列表不变', async () => {
    callCapability.mockResolvedValueOnce({ friends: [friend('a', 'Alice')] })
    const store = useFriendsStore()
    await store.loadFriends()
    callCapability.mockRejectedValueOnce(new CapabilityError('not found: 他不是你的好友', 'not_found', 404))
    await expect(store.updateFriend('a', { remark: '新备注', group_name: '' })).rejects.toThrow()
    expect(store.friends[0]!.remark).toBeNull()
  })
})

describe('removeFriend', () => {
  it('删除成功后从列表里去掉;失败不动', async () => {
    callCapability.mockResolvedValueOnce({ friends: [friend('a', 'Alice'), friend('b', 'Bob')] })
    const store = useFriendsStore()
    await store.loadFriends()
    callCapability.mockRejectedValueOnce(new Error('boom'))
    await expect(store.removeFriend('a')).rejects.toThrow()
    expect(store.friends).toHaveLength(2)
    callCapability.mockResolvedValueOnce({ removed: true })
    await store.removeFriend('a')
    expect(callCapability).toHaveBeenLastCalledWith('friend_remove', { user_id: 'a' })
    expect(store.friends.map((item) => item.id)).toEqual(['b'])
  })
})

const profile = (id: string, name: string) => ({ id: `usr_${id}`, username: id, display_name: name, avatar: null })
const incomingRow = (id: string, from: string): IncomingRequest => ({ id, from: profile(from, from), message: null, created_at: 1, expires_at: 2 })
const outgoingRow = (id: string, to: string): OutgoingRequest => ({ id, to: profile(to, to), message: null, created_at: 1, expires_at: 2 })

describe('loadRequests', () => {
  it('收到的和发出的各放各的,状态变 ready', async () => {
    callCapability.mockResolvedValue({ incoming: [incomingRow('frq_1', 'zhao')], outgoing: [outgoingRow('frq_2', 'erin')] })
    const store = useFriendsStore()
    await store.loadRequests()
    expect(callCapability).toHaveBeenCalledWith('friend_requests', {})
    expect(store.incoming.map((item) => item.id)).toEqual(['frq_1'])
    expect(store.outgoing.map((item) => item.id)).toEqual(['frq_2'])
    expect(store.requestsStatus).toBe('ready')
  })

  it('失败:状态 error + 人话;好友列表不受影响', async () => {
    callCapability.mockResolvedValueOnce({ friends: [friend('a', 'Alice')] })
    const store = useFriendsStore()
    await store.loadFriends()
    callCapability.mockRejectedValueOnce(new CapabilityError('internal: x', 'internal', 500))
    await store.loadRequests()
    expect(store.requestsStatus).toBe('error')
    expect(store.requestsError).toBe('没能加载好友申请。请检查网络后重试。')
    expect(store.friendsStatus).toBe('ready')
    expect(store.friends).toHaveLength(1)
  })

  it('403 标记 forbidden;静默刷新失败不改动现有数据', async () => {
    const store = useFriendsStore()
    callCapability.mockRejectedValueOnce(new CapabilityError('forbidden', 'forbidden', 403))
    await store.loadRequests()
    expect(store.forbidden).toBe(true)
    callCapability.mockResolvedValueOnce({ incoming: [incomingRow('frq_1', 'zhao')], outgoing: [] })
    await store.loadRequests()
    callCapability.mockRejectedValueOnce(new Error('offline'))
    await store.loadRequests({ silent: true })
    expect(store.requestsStatus).toBe('ready')
    expect(store.incoming).toHaveLength(1)
  })
})

describe('decide', () => {
  async function withRequests() {
    callCapability.mockResolvedValueOnce({ incoming: [incomingRow('frq_1', 'zhao'), incomingRow('frq_2', 'qian')], outgoing: [] })
    const store = useFriendsStore()
    await store.loadRequests()
    return store
  }

  it('通过:参数是申请 id 和 accept;这一条从列表里去掉,并静默刷新好友', async () => {
    const store = await withRequests()
    callCapability.mockResolvedValueOnce({ state: 'accepted' })
    callCapability.mockResolvedValueOnce({ friends: [friend('zhao', '赵')] })
    await store.decide('frq_1', 'accept')
    expect(callCapability).toHaveBeenCalledWith('friend_decide', { id: 'frq_1', decision: 'accept' })
    expect(store.incoming.map((item) => item.id)).toEqual(['frq_2'])
    expect(callCapability).toHaveBeenLastCalledWith('friend_list', {})
  })

  it('拒绝 / 忽略:这一条去掉,不去刷新好友列表', async () => {
    const store = await withRequests()
    callCapability.mockResolvedValue({ state: 'rejected' })
    await store.decide('frq_1', 'reject')
    await store.decide('frq_2', 'ignore')
    expect(store.incoming).toEqual([])
    expect(callCapability.mock.calls.filter((call) => call[0] === 'friend_list')).toHaveLength(0)
  })

  it('失败(比如 404:已在别处处理过):抛出错误,同时后台刷新申请列表', async () => {
    const store = await withRequests()
    callCapability.mockRejectedValueOnce(new CapabilityError('not found: 没有这条好友申请', 'not_found', 404))
    callCapability.mockResolvedValueOnce({ incoming: [incomingRow('frq_2', 'qian')], outgoing: [] })
    await expect(store.decide('frq_1', 'accept')).rejects.toThrow()
    await flushPromises()
    expect(store.incoming.map((item) => item.id)).toEqual(['frq_2'])
  })
})

describe('拉黑', () => {
  const blockedRow = (id: string) => ({ user: profile(id, id), since: 5 })

  it('loadBlocks:放进列表;失败给人话,403 标记没开通', async () => {
    const store = useFriendsStore()
    callCapability.mockResolvedValueOnce({ blocked: [blockedRow('spam')] })
    await store.loadBlocks()
    expect(callCapability).toHaveBeenCalledWith('block_list', {})
    expect(store.blocked.map((item) => item.user.id)).toEqual(['usr_spam'])
    expect(store.blocksStatus).toBe('ready')
    callCapability.mockRejectedValueOnce(new CapabilityError('internal: x', 'internal', 500))
    await store.loadBlocks()
    expect(store.blocksStatus).toBe('error')
    expect(store.blocksError).toBe('没能加载拉黑名单。请检查网络后重试。')
    callCapability.mockRejectedValueOnce(new CapabilityError('forbidden', 'forbidden', 403))
    await store.loadBlocks()
    expect(store.forbidden).toBe(true)
  })

  it('block:拉黑后好友、申请、拉黑名单三块一起静默刷新(后端会解除好友、作废申请)', async () => {
    const store = useFriendsStore()
    callCapability.mockImplementation(async (name: string) => {
      if (name === 'friend_list') return { friends: [] }
      if (name === 'friend_requests') return { incoming: [], outgoing: [] }
      if (name === 'block_list') return { blocked: [blockedRow('bob')] }
      return { blocked: true }
    })
    await store.block('usr_bob')
    expect(callCapability).toHaveBeenCalledWith('block', { user_id: 'usr_bob' })
    const asked = callCapability.mock.calls.map((call) => call[0]).sort()
    expect(asked).toEqual(['block', 'block_list', 'friend_list', 'friend_requests'])
    expect(store.blocked.map((item) => item.user.id)).toEqual(['usr_bob'])
  })

  it('block 失败:抛出错误,不刷新别的', async () => {
    const store = useFriendsStore()
    callCapability.mockRejectedValueOnce(new CapabilityError('invalid input: 不能拉黑自己', 'invalid_input', 400))
    await expect(store.block('usr_me')).rejects.toThrow()
    expect(callCapability).toHaveBeenCalledTimes(1)
  })

  it('unblock:成功后这一条从名单里去掉;失败不动', async () => {
    const store = useFriendsStore()
    callCapability.mockResolvedValueOnce({ blocked: [blockedRow('a'), blockedRow('b')] })
    await store.loadBlocks()
    callCapability.mockRejectedValueOnce(new Error('boom'))
    await expect(store.unblock('usr_a')).rejects.toThrow()
    expect(store.blocked).toHaveLength(2)
    callCapability.mockResolvedValueOnce({ unblocked: true })
    await store.unblock('usr_a')
    expect(callCapability).toHaveBeenLastCalledWith('unblock', { user_id: 'usr_a' })
    expect(store.blocked.map((item) => item.user.id)).toEqual(['usr_b'])
  })
})

describe('隐私设置', () => {
  const base = { searchable_by_email: false, searchable_by_username: true, share_from: 'everyone' as const }

  it('loadPrivacy 读到设置;失败状态 error', async () => {
    const store = useFriendsStore()
    callCapability.mockResolvedValueOnce({ privacy: base })
    await store.loadPrivacy()
    expect(callCapability).toHaveBeenCalledWith('privacy_get', {})
    expect(store.privacy).toEqual(base)
    callCapability.mockRejectedValueOnce(new CapabilityError('internal: x', 'internal', 500))
    await store.loadPrivacy()
    expect(store.privacyStatus).toBe('error')
    expect(store.privacyError).toBe('没能加载隐私设置。请检查网络后重试。')
  })

  it('savePrivacy:只发改动的那一项;请求期间界面已经是新值,完成后以服务端返回为准', async () => {
    const store = useFriendsStore()
    callCapability.mockResolvedValueOnce({ privacy: base })
    await store.loadPrivacy()
    let during: unknown = null
    callCapability.mockImplementationOnce(async () => {
      during = { ...store.privacy }
      return { privacy: { ...base, searchable_by_email: true } }
    })
    await store.savePrivacy({ searchable_by_email: true })
    expect(callCapability).toHaveBeenLastCalledWith('set_privacy', { searchable_by_email: true })
    expect(during).toEqual({ ...base, searchable_by_email: true })
    expect(store.privacy).toEqual({ ...base, searchable_by_email: true })
  })

  it('savePrivacy 失败:退回原值再抛错,开关不会停在没存上的状态', async () => {
    const store = useFriendsStore()
    callCapability.mockResolvedValueOnce({ privacy: base })
    await store.loadPrivacy()
    callCapability.mockRejectedValueOnce(new CapabilityError('internal: x', 'internal', 500))
    await expect(store.savePrivacy({ share_from: 'friends' })).rejects.toThrow()
    expect(store.privacy).toEqual(base)
  })

  it('还没读到设置时 savePrivacy 什么都不做', async () => {
    const store = useFriendsStore()
    await store.savePrivacy({ share_from: 'friends' })
    expect(callCapability).not.toHaveBeenCalled()
  })
})
