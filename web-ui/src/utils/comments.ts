// 评论串的纯逻辑:把后端平铺的评论列表整理成「顶层评论 + 回复」、按已解决筛选、认出作者。@ 提及在 mentions.ts。
// 界面组件(components/share/DocComments.vue 与 components/comments/*)只管渲染和请求,规则都在这里,方便单测。
//
// 后端形状(crates/kb-cli/tests/e2e_comments.rs 是权威):
//   list_annotations → { annotations: [{ id, body, author, parent_id, resolved_at, resolved_by, mentions, created_at, anchor }],
//                        authors: { <用户 id>: { id, username?, display_name, avatar } } }
//   作者 author:登录用户是用户 id(`usr_…`),游客是 `guest:昵称#编号`,工具是 `web` / `mcp · …`。
//   经分享链接匿名查看时 authors 里没有 username(只有显示名和头像)。
import { annotationAuthor, shareErrorText } from '@/utils/share'

export interface CommentProfile {
  id: string
  /** 匿名访客看到的资料里没有它 */
  username?: string
  display_name: string
  avatar: string | null
}
export type CommentAuthors = Record<string, CommentProfile>

export interface CommentRecord {
  id: string
  body: string
  author: string | null
  created_at: number
  /** 回复哪条顶层评论;顶层评论没有 */
  parent_id?: string | null
  /** 已解决的时间 / 谁标记的;只有顶层评论会被标记,回复跟着它走 */
  resolved_at?: number | null
  resolved_by?: string | null
  /** 真正被通知到的用户 id。界面不能用它去显示「通知了谁」(那会暴露谁存在),只用来判断有没有 @ 过人 */
  mentions?: string[]
  /** 锚点(页 / 单元格 / 时间点…);笔记的评论没有 */
  anchor?: { kind: string; [key: string]: unknown } | null
}

export interface CommentThread {
  /** 顶层评论的 id;孤儿回复串用 `orphan:<父评论 id>` */
  id: string
  /** 顶层评论。后端一次最多返回最近 100 条,回复的父评论可能更早、不在这次结果里,这时是 null */
  root: CommentRecord | null
  replies: CommentRecord[]
  resolved: boolean
}

const byTime = (left: CommentRecord, right: CommentRecord) => left.created_at - right.created_at || left.id.localeCompare(right.id)

/**
 * 平铺列表 → 评论串。串按顶层评论的时间从旧到新排(像聊天一样往下追加),回复也按时间。
 * 回复只有一层;父评论不在结果里的回复(列表被条数上限截断)按父评论 id 归成一串,不丢也不乱挂到别处。
 */
export function buildThreads(items: CommentRecord[]): CommentThread[] {
  const roots = items.filter((item) => !item.parent_id).sort(byTime)
  const replies = new Map<string, CommentRecord[]>()
  for (const item of items) {
    if (!item.parent_id) continue
    const group = replies.get(item.parent_id) ?? []
    group.push(item)
    replies.set(item.parent_id, group)
  }
  const threads: CommentThread[] = roots.map((root) => ({
    id: root.id,
    root,
    replies: (replies.get(root.id) ?? []).sort(byTime),
    resolved: !!root.resolved_at,
  }))
  const known = new Set(roots.map((root) => root.id))
  for (const [parentId, group] of replies) {
    if (known.has(parentId)) continue
    threads.push({ id: `orphan:${parentId}`, root: null, replies: group.sort(byTime), resolved: false })
  }
  const startOf = (thread: CommentThread) => thread.root?.created_at ?? thread.replies[0]?.created_at ?? 0
  return threads.sort((left, right) => startOf(left) - startOf(right))
}

export type CommentFilter = 'all' | 'open'

export const openThreads = (threads: CommentThread[]): CommentThread[] => threads.filter((thread) => !thread.resolved)
export const filterThreads = (threads: CommentThread[], filter: CommentFilter): CommentThread[] => (filter === 'open' ? openThreads(threads) : threads)

/** 评论总条数(含回复) */
export const commentCount = (threads: CommentThread[]): number => threads.reduce((sum, thread) => sum + (thread.root ? 1 : 0) + thread.replies.length, 0)

/** 这条评论(顶层或回复)在哪一串里;找不到(已被删、不在这次结果里)返回 null。 */
export function threadOf(threads: CommentThread[], commentId: string): CommentThread | null {
  return threads.find((thread) => thread.root?.id === commentId || thread.replies.some((reply) => reply.id === commentId)) ?? null
}

/**
 * 评论请求失败的提示。后端对「评论 / 文档找不到」的 404 消息是 `评论 <内部 id>`,直接显示会把 id 露给用户,
 * 而且没说怎么办,所以 404 统一换成人话;其余沿用分享里的通用转换(中文消息原样用)。
 */
export function commentErrorText(error: unknown, fallback: string): string {
  if ((error as { status?: number } | null)?.status === 404) return '这条评论或这篇文档已经不在了,可能刚被删除或移走。刷新页面后再试。'
  return shareErrorText(error, fallback)
}

// ---------------------------------------------------------------- 作者

export interface AuthorView {
  /** 显示名:自己是「我」,游客是「访客 昵称」,登录用户是显示名(没有资料时「协作者」) */
  name: string
  /** 用户名(带 @ 之前的);匿名访客拿不到、游客和工具没有,都是 null */
  username: string | null
  /** 画头像用:登录用户有 id;游客和工具没有,画首字母 */
  userId: string | null
  avatar: string | null
  isMe: boolean
  kind: 'user' | 'guest' | 'tool' | 'unknown'
}

/**
 * 评论作者怎么显示。资料来自 list_annotations 返回的 authors(评论者没有权限单独查别人的资料);
 * 不在映射里的用户 id(账号被删、列表被截断)显示「协作者」,绝不把内部 id 露出来。
 */
export function authorView(author: string | null | undefined, authors: CommentAuthors | undefined, myId?: string | null): AuthorView {
  const value = (author ?? '').trim()
  if (!value) return { name: '匿名', username: null, userId: null, avatar: null, isMe: false, kind: 'unknown' }
  if (value.startsWith('guest:')) return { name: annotationAuthor(value), username: null, userId: null, avatar: null, isMe: false, kind: 'guest' }
  if (/^usr_/.test(value)) {
    const profile = authors?.[value]
    const isMe = !!myId && value === myId
    const shown = profile?.display_name?.trim() || profile?.username || ''
    return {
      name: isMe ? '我' : shown || '协作者',
      username: profile?.username ?? null,
      userId: value,
      avatar: profile?.avatar ?? null,
      isMe,
      kind: 'user',
    }
  }
  return { name: value, username: null, userId: null, avatar: null, isMe: false, kind: 'tool' }
}

/** 「谁标记的已解决」。不在资料映射里就不点名(只说「已解决」)。 */
export function resolverName(resolvedBy: string | null | undefined, authors: CommentAuthors | undefined, myId?: string | null): string {
  if (!resolvedBy) return ''
  if (myId && resolvedBy === myId) return '我'
  const profile = authors?.[resolvedBy]
  return profile?.display_name?.trim() || profile?.username || ''
}
