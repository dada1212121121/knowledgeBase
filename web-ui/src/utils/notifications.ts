// 通知怎么显示:每种通知的名字 / 分类 / 图标、一行人话、点了去哪。
//
// 后端只存「种类 + 一个 JSON」(kb-core/src/social.rs 的 kind、各 *_backend.rs 里发通知的地方),
// 怎么写成一句话、点了跳到哪是前端的事。数据形状以后端发送处为准:
//   friend_request  { request_id, from, message }
//   friend_result   { request_id?, accepted, by, via_invite? }
//   share_received  { key, target, title, count, role, role_label, from }
//   access_request  { request_id, key, target, title, requester, role, role_label, message }
//   access_result   { request_id, key, target, title, approved, role, role_label, by }
//   collaborator_removed { key, target, title, from }
// 评论回复 / 提到我 / 链接即将到期 / 系统公告 后端还没有发送处,这里按「有什么字段就用什么」写,缺字段时退回通用文案,
// 所以后端以后补上这些通知不需要改界面(字段名约定见各函数里的注释)。
// 用户写的文字(昵称、文档标题、附言)一律当纯文本,不会被当成 HTML。
import type { RouteLocationRaw } from 'vue-router'
import type { IconName } from '@kb-ui/index'
import type { PublicProfile } from '@/api/social'
import { PATHS } from '@/router/paths'

export type NotificationCategory = 'friend' | 'share' | 'comment' | 'system'

export const CATEGORIES: { value: 'all' | NotificationCategory; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'friend', label: '好友' },
  { value: 'share', label: '分享' },
  { value: 'comment', label: '评论' },
  { value: 'system', label: '系统' },
]

interface KindInfo {
  label: string
  category: NotificationCategory
  icon: IconName
  /** 一句话说明这类通知什么时候出现(通知偏好页里显示)。 */
  hint: string
}

/** 与后端 kb-core/src/social.rs 的 kind::ALL / kind::label 一一对应(顺序也是通知偏好页里的顺序)。 */
export const KIND_INFO: Record<string, KindInfo> = {
  friend_request: { label: '好友申请', category: 'friend', icon: 'users', hint: '有人请求加你为好友' },
  friend_result: { label: '好友申请结果', category: 'friend', icon: 'users', hint: '你发出的好友申请被通过或拒绝' },
  share_received: { label: '收到分享', category: 'share', icon: 'share', hint: '有人把文档分享给你' },
  access_request: { label: '访问申请', category: 'share', icon: 'lock', hint: '有人申请访问你的文档' },
  access_result: { label: '访问申请结果', category: 'share', icon: 'key', hint: '你的访问申请被同意或拒绝' },
  comment_reply: { label: '评论回复', category: 'comment', icon: 'note', hint: '有人回复了你的评论' },
  mention: { label: '有人提到我', category: 'comment', icon: 'user', hint: '有人在评论里提到了你' },
  collaborator_removed: { label: '被移出协作者', category: 'share', icon: 'users', hint: '你被移出了某份文档的协作者' },
  link_expiring: { label: '分享链接即将到期', category: 'share', icon: 'clock', hint: '你创建的分享链接快要到期' },
  announcement: { label: '系统公告', category: 'system', icon: 'bell', hint: '管理员发布的系统公告' },
}

/** 通知偏好页按这个顺序列(后端返回的 kinds 优先,没有时用它)。 */
export const KIND_ORDER = Object.keys(KIND_INFO)

const FALLBACK: KindInfo = { label: '通知', category: 'system', icon: 'bell', hint: '' }
/** 不认识的种类(后端新增了、前端还没跟上)归「系统」,用通用图标和文案,不显示原始 JSON。 */
export const kindInfo = (kind: string): KindInfo => KIND_INFO[kind] ?? FALLBACK
export const categoryOf = (kind: string): NotificationCategory => kindInfo(kind).category

type Data = Record<string, unknown>
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/** 从通知数据里取一个人的资料;形状不对就当没有。 */
export function profileOf(value: unknown): PublicProfile | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Data
  const id = text(raw.id)
  const username = text(raw.username)
  if (!id || !username) return null
  return { id, username, display_name: text(raw.display_name), avatar: text(raw.avatar) || null }
}

const nameOf = (profile: PublicProfile | null): string => (profile ? profile.display_name.trim() || profile.username : '有人')
/** 好友相关的通知带上 @用户名:昵称可以重名,用户名不会,收到陌生人的申请时要靠它认人。 */
const withHandle = (profile: PublicProfile | null): string => (profile ? `${nameOf(profile)}(@${profile.username})` : '有人')
/** 附言加上引号,和正文区分开。 */
const quoted = (value: unknown): string => (text(value) ? `“${text(value)}”` : '')
/** 文档标题,缺了就说「一份文档」。 */
const docTitle = (data: Data): string => `「${text(data.title) || '一份文档'}」`

export interface NotificationView {
  /** 一句话。 */
  title: string
  /** 第二行(附言、权限、摘要);没有就是空串。 */
  detail: string
  /** 这件事是谁做的(用来画头像);没有就用种类图标。 */
  actor: PublicProfile | null
}

/** 把一条通知写成人话。永远不抛错、不返回原始 JSON。 */
export function describeNotification(notification: { kind: string; data: Data }): NotificationView {
  const data = notification.data && typeof notification.data === 'object' ? notification.data : {}
  const roleLabel = text(data.role_label)
  switch (notification.kind) {
    case 'friend_request': {
      const from = profileOf(data.from)
      return { title: `${withHandle(from)} 请求加你为好友`, detail: quoted(data.message), actor: from }
    }
    case 'friend_result': {
      const by = profileOf(data.by)
      if (data.via_invite === true) return { title: `${withHandle(by)} 通过你的邀请码加入,已自动成为你的好友`, detail: '', actor: by }
      return { title: `${withHandle(by)} ${data.accepted === true ? '通过了' : '没有通过'}你的好友申请`, detail: '', actor: by }
    }
    case 'share_received': {
      const from = profileOf(data.from)
      const count = typeof data.count === 'number' ? data.count : 1
      return {
        title: count > 1 ? `${nameOf(from)} 向你分享了 ${count} 项内容` : `${nameOf(from)} 向你分享了${docTitle(data)}`,
        detail: roleLabel ? `你的权限:${roleLabel}` : '',
        actor: from,
      }
    }
    case 'access_request': {
      const requester = profileOf(data.requester)
      return { title: `${nameOf(requester)} 申请${docTitle(data)}的${roleLabel || '访问'}权限`, detail: quoted(data.message), actor: requester }
    }
    case 'access_result': {
      const by = profileOf(data.by)
      const approved = data.approved === true
      return {
        title: `${nameOf(by)} ${approved ? '同意' : '拒绝'}了你对${docTitle(data)}的访问申请`,
        detail: approved && roleLabel ? `你的权限:${roleLabel}` : '',
        actor: by,
      }
    }
    case 'collaborator_removed': {
      const from = profileOf(data.from)
      return { title: `${nameOf(from)} 把你从${docTitle(data)}的协作者中移除了`, detail: '', actor: from }
    }
    // 评论回复、提到我:约定字段 from(谁)、title(哪份文档)、excerpt / text(摘要)
    case 'comment_reply': {
      const from = profileOf(data.from)
      return { title: `${nameOf(from)} 回复了你在${docTitle(data)}的评论`, detail: text(data.excerpt) || text(data.text), actor: from }
    }
    case 'mention': {
      const from = profileOf(data.from)
      return { title: `${nameOf(from)} 在${docTitle(data)}里提到了你`, detail: text(data.excerpt) || text(data.text), actor: from }
    }
    case 'link_expiring':
      return { title: `${docTitle(data)}的分享链接即将到期`, detail: '', actor: null }
    // 系统公告:约定字段 title、body(或 message)
    case 'announcement':
      return { title: text(data.title) || '系统公告', detail: text(data.body) || text(data.message), actor: null }
    default:
      return { title: kindInfo(notification.kind).label, detail: '', actor: null }
  }
}

/** 通知数据里的 target(ShareTarget:kind / space_id / collection / path / id)。 */
interface Target {
  kind: string
  space_id?: string
  collection?: string
  path?: string
  id?: string
}
const targetOf = (data: Data): Target | null => {
  const raw = data.target
  if (!raw || typeof raw !== 'object') return null
  const target = raw as Data
  const kind = text(target.kind)
  return kind ? { kind, space_id: text(target.space_id), collection: text(target.collection), path: text(target.path), id: text(target.id) } : null
}

/**
 * 点了通知去哪。没有可去的地方返回 null(这时这一行不可点,只能标为已读):
 *   - 好友申请 → 好友页「申请」页签;申请结果 → 好友页;
 *   - 有 target 的(分享、访问申请、评论……)→ 知识库里对应的位置;别人知识库里的内容多带一个 `space` 参数
 *     (知识库页对「共享给我」的支持属于分享与协作那部分,没接上之前这个参数会被忽略,落在我自己的知识库);
 *   - 被移出协作者 → null(已经没有权限了,点过去只会是「没有权限」)。
 */
export function notificationTarget(notification: { kind: string; data: Data }, mySpaceId: string | null): RouteLocationRaw | null {
  const data = notification.data && typeof notification.data === 'object' ? notification.data : {}
  switch (notification.kind) {
    case 'friend_request':
      return { path: PATHS.friends, query: { tab: 'requests' } }
    case 'friend_result':
      return { path: PATHS.friends }
    case 'collaborator_removed':
    case 'announcement':
      return null
  }
  const target = targetOf(data)
  if (!target) return null
  const query: Record<string, string> = {}
  if (target.collection) query.collection = target.collection
  if (target.kind === 'insight' && target.id) query.item = target.id
  else if (target.kind === 'file' && target.path) query.path = target.path
  else if (target.kind === 'dir' && target.path) query.dir = target.path
  // 别人知识库里的文档:知识库页要切到「共享给我」,凭 space + 文档位置找到覆盖它的那条授权再打开(我自己的知识库里没有它)
  if (target.space_id && target.space_id !== mySpaceId) {
    query.space = target.space_id
    query.scope = 'shared'
  }
  // 评论回复 / 提到我:带上评论 id,知识库页打开评论页签并定位到那一条
  if ((notification.kind === 'comment_reply' || notification.kind === 'mention') && text(data.annotation_id)) query.comment = text(data.annotation_id)
  return { path: PATHS.kb, query }
}
