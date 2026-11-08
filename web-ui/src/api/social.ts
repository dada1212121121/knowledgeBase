// 好友与通知相关能力的类型和调用。
//
// 形状以后端为准,不靠猜:参数结构在 crates/kb-capability/src/social.rs,
// 响应的真实 JSON 在 crates/kb-cli/src/social_backend.rs(各 do_* 函数)和 crates/kb-cli/tests/e2e_social.rs。
// 这里的类型用 `type` 而不是 `interface`:要能直接当 KbResponsiveTable 的行(Record<string, unknown>)用。
import { callCapability } from '@/api/client'

/** 别人能看到的一个人的资料:没有邮箱等私密字段(后端 PublicProfile)。 */
export type PublicProfile = {
  id: string
  username: string
  display_name: string
  /** 头像文件名;没有就是 null,界面画首字母。 */
  avatar: string | null
}

/** 搜索结果里这个人和我的关系。 */
export type Relation = 'none' | 'friend' | 'pending_out' | 'pending_in'

/** 好友列表里的一行(资料是平铺的)。备注和分组只对我自己可见。 */
export type Friend = PublicProfile & {
  remark: string | null
  group_name: string | null
  /** 成为好友的时间(毫秒)。 */
  since: number
}

/** 收到的申请。 */
export type IncomingRequest = {
  id: string
  from: PublicProfile
  message: string | null
  created_at: number
  expires_at: number
}

/** 发出的、还在等的申请(对方忽略了的也显示为等待中)。 */
export type OutgoingRequest = {
  id: string
  to: PublicProfile
  message: string | null
  created_at: number
  expires_at: number
}

/** 拉黑名单里的一行:只有最少的资料和时间。 */
export type BlockedUser = { user: PublicProfile; since: number }

export type ShareFrom = 'everyone' | 'friends'

export type Privacy = {
  searchable_by_email: boolean
  searchable_by_username: boolean
  share_from: ShareFrom
}

/** `friend_request` 的结果:被对方拉黑时和成功一样返回 requested(后端刻意不暴露)。 */
export type RequestStatus = 'requested' | 'friends' | 'already_friends' | 'already_pending'

/** `friend_decide` 的决定。 */
export type Decision = 'accept' | 'reject' | 'ignore'

export const friendSearch = (query: string) =>
  callCapability<{ user: PublicProfile | null; relation: Relation }>('friend_search', { query })

export const friendRequest = (userId: string, message?: string) =>
  callCapability<{ status: RequestStatus }>('friend_request', { user_id: userId, ...(message ? { message } : {}) })

export const friendRequests = () => callCapability<{ incoming: IncomingRequest[]; outgoing: OutgoingRequest[] }>('friend_requests', {})

export const friendDecide = (id: string, decision: Decision) =>
  callCapability<{ state: 'accepted' | 'rejected' | 'ignored' }>('friend_decide', { id, decision })

export const friendList = () => callCapability<{ friends: Friend[] }>('friend_list', {})

/** 改备注和分组:传 null 表示清除(后端:写 null 或空串 = 清除,不写 = 不改)。 */
export const friendUpdate = (friendId: string, fields: { remark: string | null; group_name: string | null }) =>
  callCapability<{ updated: boolean }>('friend_update', { friend_id: friendId, ...fields })

export const friendRemove = (userId: string) => callCapability<{ removed: boolean }>('friend_remove', { user_id: userId })

export const blockUser = (userId: string) => callCapability<{ blocked: boolean }>('block', { user_id: userId })

export const unblockUser = (userId: string) => callCapability<{ unblocked: boolean }>('unblock', { user_id: userId })

export const blockList = () => callCapability<{ blocked: BlockedUser[] }>('block_list', {})

export const privacyGet = () => callCapability<{ privacy: Privacy }>('privacy_get', {})

export const privacySet = (patch: Partial<Privacy>) => callCapability<{ privacy: Privacy }>('set_privacy', patch)

/** 通知偏好:每种通知要不要同时发邮件。不带参数是读取。 */
export type NotificationPrefs = {
  email: Record<string, boolean>
  /** 后端认识的全部种类(顺序即界面顺序)。 */
  kinds: string[]
  /** 站点有没有配好发信;没配时开关改了也发不出邮件。 */
  mail_available: boolean
}

export async function notificationPrefs(email?: Record<string, boolean>): Promise<NotificationPrefs> {
  const reply = await callCapability<Partial<NotificationPrefs>>('notification_prefs', email ? { email } : {})
  // 缺字段按「没有」处理,不让一个残缺的响应把整张卡片弄崩
  return { email: reply.email ?? {}, kinds: reply.kinds ?? [], mail_available: reply.mail_available === true }
}
