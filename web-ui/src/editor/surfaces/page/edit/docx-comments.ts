/**
 * Word 评论的纯逻辑：把引擎给的平铺评论整理成侧栏要的"线程"，以及各种动作的前置判断。
 *
 * 引擎的评论是一张平铺的表：每条有 `parentId`（回复指向被回复的那条）、`done`（已解决）。
 * 侧栏要的是：根评论按它在文档里的位置排序，每个根下面按时间排它的回复；已解决的线程折叠到下面。
 * 这些整理、以及"谁能做什么"的判断都是纯函数，与引擎、DOM 无关，直接单测。
 */

/** 引擎的评论（`YrsCommentInfo`）里侧栏用到的字段 */
export interface RawComment {
  id: string
  author: string
  /** ISO 时间 */
  date: string
  done: boolean
  parentId: string | null
  /** 创建时给的内容：我们创建的都是纯文本字符串；别的编辑器（Word）写的可能是结构，取不出文字就显示空 */
  body: unknown
}

export interface CommentView {
  id: string
  author: string
  date: string
  text: string
  /** 是我写的 */
  mine: boolean
}

export interface CommentThread {
  root: CommentView & { done: boolean }
  replies: CommentView[]
  /** 根评论在文档里的位置序号（0 起），排序用；引擎没给位置时为 Infinity，排到最后 */
  order: number
}

/** 评论正文取纯文本。创建时是字符串；Word 写的是段落结构，递归取所有 text 叶子 */
export function commentText(body: unknown): string {
  if (typeof body === 'string') return body
  if (!body || typeof body !== 'object') return ''
  if (Array.isArray(body)) return body.map(commentText).filter(Boolean).join('\n')
  const node = body as { text?: unknown; content?: unknown }
  if (typeof node.text === 'string') return node.text
  return commentText(node.content)
}

/**
 * 整理成线程。
 * - 回复的 `parentId` 指向的评论不存在（被删了、或引擎里还没同步到）时，当作独立的根显示，不丢；
 * - 回复的回复（理论上 Word 不产生）并到最顶层的根下面，按时间排；
 * - `positions` 是根评论 id → 文档位置序号；没有的排最后，同位置按时间。
 */
export function buildThreads(comments: readonly RawComment[], positions: ReadonlyMap<string, number>, me: string): CommentThread[] {
  const byId = new Map(comments.map((comment) => [comment.id, comment]))
  const rootOf = (comment: RawComment): RawComment => {
    const seen = new Set<string>()
    let current = comment
    while (current.parentId && byId.has(current.parentId) && !seen.has(current.id)) {
      seen.add(current.id)
      current = byId.get(current.parentId)!
    }
    return current
  }
  const view = (comment: RawComment): CommentView => ({ id: comment.id, author: comment.author, date: comment.date, text: commentText(comment.body), mine: comment.author === me })
  const threads = new Map<string, CommentThread>()
  for (const comment of comments) {
    const root = rootOf(comment)
    if (!threads.has(root.id)) threads.set(root.id, { root: { ...view(root), done: root.done }, replies: [], order: positions.get(root.id) ?? Number.POSITIVE_INFINITY })
  }
  for (const comment of comments) {
    const root = rootOf(comment)
    if (comment.id !== root.id) threads.get(root.id)!.replies.push(view(comment))
  }
  for (const thread of threads.values()) thread.replies.sort((left, right) => left.date.localeCompare(right.date))
  return [...threads.values()].sort((left, right) => left.order - right.order || left.root.date.localeCompare(right.root.date))
}

/** 侧栏分两组：进行中、已解决（折叠） */
export function splitByState(threads: readonly CommentThread[]): { open: CommentThread[]; resolved: CommentThread[] } {
  return { open: threads.filter((thread) => !thread.root.done), resolved: threads.filter((thread) => thread.root.done) }
}

/** 评论正文的前置检查：空的不提交；过长的拒绝（引擎能存，但侧栏和导出都不适合） */
export const COMMENT_MAX_CHARS = 4000

export function validateCommentText(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return '评论内容不能为空'
  if (trimmed.length > COMMENT_MAX_CHARS) return `评论太长了（${trimmed.length} 字，最多 ${COMMENT_MAX_CHARS} 字）`
  return null
}

export interface CommentPermissions {
  canComment: boolean
  canResolve: boolean
  canDelete: (comment: CommentView) => boolean
}

/**
 * 谁能做什么。引擎本身不管权限，由宿主定：
 * - 只读（查看者 / 没拿到编辑权）：什么都不能做，只能看；
 * - 能编辑的人可以评论、回复、解决 / 重开别人的评论（文档协作的常见约定：解决不是"改别人的话"）；
 * - 删除只能删自己写的——别人的评论被删了他看不到，是更伤人的操作。
 */
export function commentPermissions(editable: boolean): CommentPermissions {
  return { canComment: editable, canResolve: editable, canDelete: (comment) => editable && comment.mine }
}

/** 相对时间，侧栏里每条评论旁显示；超过一周显示日期 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return ''
  const seconds = Math.max(0, Math.round((now - time) / 1000))
  if (seconds < 45) return '刚刚'
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`
  if (seconds < 86400) return `${Math.round(seconds / 3600)} 小时前`
  if (seconds < 7 * 86400) return `${Math.round(seconds / 86400)} 天前`
  return new Date(time).toLocaleDateString('zh-CN')
}
