// 好友页的数据:好友列表、收到 / 发出的申请、拉黑名单、隐私设置。
//
// 放进 store 而不是页面里,是因为 WebSocket 推来「有人加你 / 通过了你的申请」时要能静默刷新,
// 也方便单测。每一块数据各有自己的状态:一块失败不会让整页变空白。
import { defineStore } from 'pinia'
import { ref } from 'vue'
import {
  blockList,
  blockUser,
  friendDecide,
  friendList,
  friendRemove,
  friendRequests,
  friendUpdate,
  privacyGet,
  privacySet,
  unblockUser,
  type BlockedUser,
  type Decision,
  type Friend,
  type IncomingRequest,
  type OutgoingRequest,
  type Privacy,
} from '@/api/social'
import { isFeatureOff, socialErrorText, sortFriends } from '@/utils/social'

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error'

/** 备注、分组:去掉首尾空白,空串当作清除(与后端 update_friend 的规则一致)。 */
const clean = (value: string): string | null => value.trim() || null

export const useFriendsStore = defineStore('friends', () => {
  const friends = ref<Friend[]>([])
  const friendsStatus = ref<LoadStatus>('idle')
  const friendsError = ref('')
  /** 后端说这个账号用不了好友功能(功能点被关掉):页面显示「没有开通」。 */
  const forbidden = ref(false)
  const incoming = ref<IncomingRequest[]>([])
  const outgoing = ref<OutgoingRequest[]>([])
  const requestsStatus = ref<LoadStatus>('idle')
  const requestsError = ref('')
  let requestsSeq = 0
  const blocked = ref<BlockedUser[]>([])
  const blocksStatus = ref<LoadStatus>('idle')
  const blocksError = ref('')
  let blocksSeq = 0
  const privacy = ref<Privacy | null>(null)
  const privacyStatus = ref<LoadStatus>('idle')
  const privacyError = ref('')
  // 并发的两次加载(用户点重试的同时 WebSocket 触发了刷新)只认最后发出的那一次,免得旧响应盖掉新数据
  let friendsSeq = 0

  /** 拉好友列表。`silent`:已经有数据时不闪骨架屏,失败也不打扰(WebSocket 触发的刷新用它)。 */
  async function loadFriends(options: { silent?: boolean } = {}) {
    const seq = ++friendsSeq
    const keep = options.silent && friendsStatus.value === 'ready'
    if (!keep) friendsStatus.value = 'loading'
    try {
      const reply = await friendList()
      if (seq !== friendsSeq) return
      friends.value = sortFriends(reply.friends ?? [])
      friendsStatus.value = 'ready'
      friendsError.value = ''
      forbidden.value = false
    } catch (err) {
      if (seq !== friendsSeq || keep) return
      if (isFeatureOff(err)) forbidden.value = true
      friendsError.value = socialErrorText(err, '没能加载好友列表。请检查网络后重试。')
      friendsStatus.value = 'error'
    }
  }

  /** 拉收到的和发出的申请。`silent` 的含义同 loadFriends。 */
  async function loadRequests(options: { silent?: boolean } = {}) {
    const seq = ++requestsSeq
    const keep = options.silent && requestsStatus.value === 'ready'
    if (!keep) requestsStatus.value = 'loading'
    try {
      const reply = await friendRequests()
      if (seq !== requestsSeq) return
      incoming.value = reply.incoming ?? []
      outgoing.value = reply.outgoing ?? []
      requestsStatus.value = 'ready'
      requestsError.value = ''
      forbidden.value = false
    } catch (err) {
      if (seq !== requestsSeq || keep) return
      if (isFeatureOff(err)) forbidden.value = true
      requestsError.value = socialErrorText(err, '没能加载好友申请。请检查网络后重试。')
      requestsStatus.value = 'error'
    }
  }

  /**
   * 处理一条收到的申请。失败抛错,由列表行显示。
   * 申请已经被处理过或过期时后端返回 404:顺手刷新一遍,让这一行消失,再把错误抛给界面。
   * 通过后好友列表多一个人,所以也静默刷新好友。
   */
  async function decide(id: string, decision: Decision) {
    try {
      await friendDecide(id, decision)
    } catch (err) {
      void loadRequests({ silent: true })
      throw err
    }
    incoming.value = incoming.value.filter((item) => item.id !== id)
    if (decision === 'accept') void loadFriends({ silent: true })
  }

  /** 拉我拉黑的人。`silent` 的含义同 loadFriends。 */
  async function loadBlocks(options: { silent?: boolean } = {}) {
    const seq = ++blocksSeq
    const keep = options.silent && blocksStatus.value === 'ready'
    if (!keep) blocksStatus.value = 'loading'
    try {
      const reply = await blockList()
      if (seq !== blocksSeq) return
      blocked.value = reply.blocked ?? []
      blocksStatus.value = 'ready'
      blocksError.value = ''
      forbidden.value = false
    } catch (err) {
      if (seq !== blocksSeq || keep) return
      if (isFeatureOff(err)) forbidden.value = true
      blocksError.value = socialErrorText(err, '没能加载拉黑名单。请检查网络后重试。')
      blocksStatus.value = 'error'
    }
  }

  /**
   * 拉黑某人。后端会同时解除好友关系、作废双方待处理的申请,所以好友、申请、拉黑名单三块数据都要跟着刷新。
   * 失败抛错,由调用的界面显示。
   */
  async function block(userId: string) {
    await blockUser(userId)
    await Promise.all([loadFriends({ silent: true }), loadRequests({ silent: true }), loadBlocks({ silent: true })])
  }

  /** 取消拉黑。不会恢复好友关系(拉黑时已经解除了)。 */
  async function unblock(userId: string) {
    await unblockUser(userId)
    blocked.value = blocked.value.filter((item) => item.user.id !== userId)
  }

  async function loadPrivacy() {
    privacyStatus.value = 'loading'
    try {
      privacy.value = (await privacyGet()).privacy
      privacyStatus.value = 'ready'
      privacyError.value = ''
      forbidden.value = false
    } catch (err) {
      if (isFeatureOff(err)) forbidden.value = true
      privacyError.value = socialErrorText(err, '没能加载隐私设置。请检查网络后重试。')
      privacyStatus.value = 'error'
    }
  }

  /**
   * 改隐私设置:界面先按新值显示(开关立刻动),服务端确认后以服务端返回的为准;
   * 失败时退回原值再抛错,开关不会停在一个没存上的状态。
   */
  async function savePrivacy(patch: Partial<Privacy>) {
    const before = privacy.value
    if (!before) return
    privacy.value = { ...before, ...patch }
    try {
      privacy.value = (await privacySet(patch)).privacy
    } catch (err) {
      privacy.value = before
      throw err
    }
  }

  /** 改备注和分组。失败抛错,由调用的对话框显示在表单里。 */
  async function updateFriend(friendId: string, fields: { remark: string; group_name: string }) {
    const next = { remark: clean(fields.remark), group_name: clean(fields.group_name) }
    await friendUpdate(friendId, next)
    friends.value = sortFriends(friends.value.map((item) => (item.id === friendId ? { ...item, ...next } : item)))
  }

  /** 删除好友。已有的分享不动(后端:分享和好友是两回事)。 */
  async function removeFriend(friendId: string) {
    await friendRemove(friendId)
    friends.value = friends.value.filter((item) => item.id !== friendId)
  }

  return {
    friends,
    friendsStatus,
    friendsError,
    forbidden,
    incoming,
    outgoing,
    requestsStatus,
    requestsError,
    blocked,
    blocksStatus,
    blocksError,
    privacy,
    privacyStatus,
    privacyError,
    loadFriends,
    loadRequests,
    loadBlocks,
    loadPrivacy,
    decide,
    block,
    unblock,
    savePrivacy,
    updateFriend,
    removeFriend,
  }
})
