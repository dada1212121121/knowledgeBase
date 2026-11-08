// 评论里的 @ 提及:解析正文、光标处补全、候选的合并与过滤。纯逻辑,界面在 components/comments/CommentComposer.vue。
//
// 规则对齐后端(crates/kb-cli/src/comment_backend.rs resolve_mentions、kb-core account.rs normalize_username):
//   用户名是 3–20 位字母 / 数字 / 下划线(不分大小写,服务端转小写);一条评论最多通知 10 个人;
//   服务端只通知「存在、账号可用、能看到这篇文档、不是自己」的人,其余静默忽略;游客的 @ 一律忽略。
// 所以候选只是方便输入,不是授权;界面也不根据「通知了谁」显示任何东西(那会暴露谁有账号)。

/** 用户名长度范围 */
export const MENTION_MIN = 3
export const MENTION_MAX_LEN = 20
/** 一条评论最多 @ 10 个人(后端 resolve_mentions 只取前 10 个),多出来的前端不再发,免得用户以为都通知到了。 */
export const MENTION_MAX_COUNT = 10

const WORD = /[A-Za-z0-9_]/
/** 前一个字符是这些时,`@` 属于邮箱 / 路径之类(a@b.com),不是提及。 */
const EMAIL_LIKE = /[A-Za-z0-9_.+\-@]/

/** 从下标 at(指向 `@`)起读一个用户名;不合规则返回 null。 */
function nameAt(text: string, at: number): { name: string; end: number } | null {
  if (text[at] !== '@') return null
  if (at > 0 && EMAIL_LIKE.test(text[at - 1]!)) return null
  let end = at + 1
  while (end < text.length && WORD.test(text[end]!)) end++
  const name = text.slice(at + 1, end)
  if (name.length < MENTION_MIN || name.length > MENTION_MAX_LEN) return null
  return { name, end }
}

/** 正文被切成的片段:普通文字,或一个 `@用户名`(用于高亮)。 */
export interface BodySegment {
  text: string
  mention: boolean
}

/**
 * 把评论正文切成片段,`@用户名` 单独成段以便高亮。
 * 高亮只看写法,不看这个用户存不存在、有没有被通知——否则谁被高亮、谁没被高亮会让人推断出谁有账号。
 */
export function bodySegments(body: string): BodySegment[] {
  const out: BodySegment[] = []
  let plain = ''
  let index = 0
  while (index < body.length) {
    const hit = body[index] === '@' ? nameAt(body, index) : null
    if (hit) {
      if (plain) out.push({ text: plain, mention: false })
      plain = ''
      out.push({ text: body.slice(index, hit.end), mention: true })
      index = hit.end
    } else {
      plain += body[index]
      index++
    }
  }
  if (plain) out.push({ text: plain, mention: false })
  return out
}

/**
 * 发送时把正文里的 `@用户名` 解析成 mentions 数组(不带 @,小写,去重,最多 10 个)。
 * 这里不管用户存不存在、能不能看到这篇文档:候选只是方便输入,不是授权,服务端会静默忽略不该通知的人。
 */
export function extractMentions(body: string): string[] {
  const names: string[] = []
  for (const segment of bodySegments(body)) {
    if (!segment.mention) continue
    const name = segment.text.slice(1).toLowerCase()
    if (!names.includes(name)) names.push(name)
  }
  return names.slice(0, MENTION_MAX_COUNT)
}

/** 光标前正在输入的 `@xxx`:返回 `@` 的位置和已经输入的部分;不在输入提及时返回 null。 */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  let start = caret - 1
  while (start >= 0 && WORD.test(text[start]!)) start--
  if (start < 0 || text[start] !== '@') return null
  if (start > 0 && EMAIL_LIKE.test(text[start - 1]!)) return null
  const query = text.slice(start + 1, caret)
  if (query.length > MENTION_MAX_LEN) return null
  return { start, query }
}

/** 选中一个候选:把 `@xxx` 换成 `@用户名 `(后面补一个空格,方便接着写)。返回新正文和光标位置。 */
export function applyMention(text: string, start: number, caret: number, username: string): { text: string; caret: number } {
  const after = text.slice(caret)
  const gap = after.startsWith(' ') || after.startsWith('\n') ? '' : ' '
  const head = `${text.slice(0, start)}@${username}${gap}`
  return { text: head + after, caret: head.length + (gap ? 0 : 1) }
}

export interface MentionCandidate {
  id: string
  username: string
  display_name: string
  avatar: string | null
  /** 这个人为什么在候选里(只是提示来源,不代表他能看到这篇文档) */
  source: 'collaborator' | 'friend' | 'commenter' | 'owner'
  /** 好友备注:搜得到,但插入的永远是用户名 */
  remark?: string | null
}

const SOURCE_RANK: Record<MentionCandidate['source'], number> = { collaborator: 0, owner: 1, commenter: 2, friend: 3 }
export const candidateSourceLabel = (source: MentionCandidate['source']): string =>
  ({ collaborator: '协作者', owner: '所有者', commenter: '参与讨论', friend: '好友' })[source]

/** 合并多个来源的候选:同一个人只留一条,来源取优先级最高的(协作者 > 所有者 > 参与讨论 > 好友);没有用户名的丢掉(没法插入)。 */
export function mergeCandidates(groups: MentionCandidate[][], excludeId?: string | null): MentionCandidate[] {
  const byId = new Map<string, MentionCandidate>()
  for (const candidate of groups.flat()) {
    if (!candidate.username || (excludeId && candidate.id === excludeId)) continue
    const known = byId.get(candidate.id)
    if (!known) byId.set(candidate.id, candidate)
    else if (SOURCE_RANK[candidate.source] < SOURCE_RANK[known.source]) byId.set(candidate.id, { ...candidate, remark: candidate.remark ?? known.remark })
  }
  return [...byId.values()].sort((left, right) => SOURCE_RANK[left.source] - SOURCE_RANK[right.source] || left.username.localeCompare(right.username))
}

/** 按已输入的部分过滤(用户名、昵称、备注,不分大小写;用户名以它开头的排前面),最多 `limit` 个。 */
export function filterCandidates(candidates: MentionCandidate[], query: string, limit = 6): MentionCandidate[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return candidates.slice(0, limit)
  const scored: { candidate: MentionCandidate; score: number }[] = []
  for (const candidate of candidates) {
    const name = candidate.username.toLowerCase()
    let score = -1
    if (name.startsWith(needle)) score = 0
    else if (name.includes(needle)) score = 1
    else if ([candidate.display_name, candidate.remark ?? ''].some((text) => text.toLowerCase().includes(needle))) score = 2
    if (score >= 0) scored.push({ candidate, score })
  }
  return scored.sort((left, right) => left.score - right.score).slice(0, limit).map((entry) => entry.candidate)
}
