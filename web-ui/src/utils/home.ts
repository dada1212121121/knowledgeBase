// 首页(个人工作台)的纯逻辑:问候语、最近编辑的合并、共享动态与待处理事项的整理。
// 和界面分开,方便单测;页面只负责取数和把这些结果画出来。
import type { AccessRequestRow, SharedWithMeItem } from '@/api/share'
import type { ItemSummary } from '@/api/client'
import type { IncomingRequest } from '@/api/social'
import { PATHS } from '@/router/paths'
import { personName, roleLabel, targetKindLabel, targetName } from '@/utils/share'

/** 按本地时间的小时问候。名字为空就只说问候,不留个孤零零的逗号。 */
export function greeting(hour: number, name: string): string {
  const word = hour < 5 ? '夜深了' : hour < 9 ? '早上好' : hour < 12 ? '上午好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好'
  // 中文句子用全角逗号(GLOSSARY §标点与排版),半角逗号在「夜深了,管理员」里挤成一条竖线
  return name.trim() ? `${word}，${name.trim()}` : word
}

/**
 * 合并多个集合各自取回的「最近更新」:按更新时间新的在前,同一条只留一次,最多 `limit` 条。
 * 只留真正的笔记(insight);代码块 / 文档块是索引出来的,不是「我在编辑的东西」。
 */
export function mergeRecent(lists: ItemSummary[][], limit: number): ItemSummary[] {
  const seen = new Set<string>()
  return lists
    .flat()
    .filter((item) => item.kind === 'insight' && item.status === 'active')
    .sort((left, right) => right.updated_at - left.updated_at)
    .filter((item) => (seen.has(item.id) ? false : (seen.add(item.id), true)))
    .slice(0, limit)
}

/** 一条笔记在首页上的显示名:标题 > 符号 > 来源路径最后一段。 */
export function itemTitle(item: Pick<ItemSummary, 'title' | 'symbol' | 'source'>): string {
  return item.title?.trim() || item.symbol?.trim() || item.source.split('/').filter(Boolean).pop() || '未命名笔记'
}

/** 点一条最近编辑的笔记:知识库页按 collection + item 直接打开。 */
export const recentRoute = (item: Pick<ItemSummary, 'collection' | 'id'>) => ({ path: PATHS.kb, query: { collection: item.collection, item: item.id } })

/** 点一条共享给我的内容:知识库页切到「共享给我」并打开它(和 Browser 的 openShared 同一套参数)。 */
export const sharedRoute = (item: Pick<SharedWithMeItem, 'key'>) => ({ path: PATHS.kb, query: { scope: 'shared', open: item.key } })

/** 共享动态里的一行:谁、什么、我是什么角色、什么时候。 */
export interface SharedRow {
  key: string
  owner: SharedWithMeItem['owner']
  ownerName: string
  headline: string
  sub: string
  to: ReturnType<typeof sharedRoute>
}

/**
 * 共享给我的最新动态:没被我移出列表的,按分享时间新的在前。
 * 只有「分享给我」这个事件的时间(shared_at),没有对方后来改了什么的记录,所以文案只说分享,不假装知道更新。
 */
export function sharedRows(items: SharedWithMeItem[], limit: number, now: number, relative: (at: number, now: number) => string): SharedRow[] {
  return items
    .filter((item) => !item.hidden)
    .sort((left, right) => right.shared_at - left.shared_at)
    .slice(0, limit)
    .map((item) => {
      const ownerName = personName(item.owner)
      const name = targetName(item.target, item.title)
      return {
        key: item.key,
        owner: item.owner,
        ownerName,
        headline: `${ownerName} 分享了${targetKindLabel(item.target)}「${name}」给你`,
        sub: `${roleLabel(item.role)} · ${relative(item.shared_at, now)}`,
        to: sharedRoute(item),
      }
    })
}

/** 待处理事项的种类;决定右侧的按钮文字和点进去去哪。 */
export type PendingKind = 'friend' | 'access' | 'review'

export interface PendingRow {
  id: string
  kind: PendingKind
  title: string
  sub: string
  action: string
  /** 好友申请 / 访问申请带头像;草稿审核没有。 */
  person?: { id: string; name: string; avatar: string | null }
  to: { path: string; query?: Record<string, string> }
}

/** 草稿数用一行代表,而不是逐条列出(逐条在审核收件箱里处理)。 */
export function pendingRows(input: {
  friends: IncomingRequest[]
  access: AccessRequestRow[]
  drafts: number
  now: number
  relative: (at: number, now: number) => string
}): PendingRow[] {
  const rows: PendingRow[] = []
  for (const request of input.friends) {
    const from = request.from
    rows.push({
      id: `friend:${request.id}`,
      kind: 'friend',
      title: `${personName(from)} 请求加你为好友`,
      sub: request.message?.trim() ? `“${request.message.trim()}”` : input.relative(request.created_at, input.now),
      action: '去处理',
      person: { id: from.id, name: personName(from), avatar: from.avatar },
      to: { path: PATHS.friends, query: { tab: 'requests' } },
    })
  }
  for (const request of input.access) {
    if (request.state !== 'pending') continue
    const who = request.requester
    const name = who ? personName(who) : '有人'
    rows.push({
      id: `access:${request.id}`,
      kind: 'access',
      title: `${name} 申请${roleLabel(request.role)}「${request.target ? targetName(request.target, request.title) : request.title}」`,
      sub: `访问申请 · ${input.relative(request.created_at, input.now)}`,
      action: '查看',
      person: who ? { id: who.id, name, avatar: who.avatar } : undefined,
      to: { path: PATHS.shares, query: { tab: 'requests' } },
    })
  }
  if (input.drafts > 0) {
    rows.push({
      id: 'review',
      kind: 'review',
      title: `${input.drafts} 条待审核的候选笔记`,
      sub: '自动提炼出的候选笔记',
      action: '去审核',
      to: { path: PATHS.review },
    })
  }
  return rows
}

/** 近期活动的汇总(首页的迷你线和活动卡用)。每个数组按天、最后一天是今天;缺的数组按 0。 */
export interface ActivitySummary {
  /** 热力格的格子:每天的「活动量」= 新建 + 编辑 + 导入 + 检索 */
  cells: { date: string; value: number }[]
  /** 最近 30 天的合计 */
  month: { notes: number; edits: number; imports: number; searches: number }
  /** 最近 30 天每天新建的笔记(迷你线) */
  notesSpark: number[]
  /** 从今天往前连续有活动的天数(今天还没有活动时从昨天算,不让一整天的空白把连续记录清零) */
  streak: number
}

export function summarizeActivity(data: { days?: string[]; notes?: number[]; edits?: number[]; imports?: number[]; searches?: number[] } | null | undefined): ActivitySummary {
  const days = data?.days ?? []
  const at = (list: number[] | undefined, index: number) => list?.[index] ?? 0
  const total = (index: number) => at(data?.notes, index) + at(data?.edits, index) + at(data?.imports, index) + at(data?.searches, index)
  const cells = days.map((date, index) => ({ date, value: total(index) }))
  const from = Math.max(0, days.length - 30)
  const sum = (list: number[] | undefined) => (list ?? []).slice(from).reduce((acc, value) => acc + value, 0)
  let streak = 0
  for (let index = days.length - 1; index >= 0; index -= 1) {
    if (total(index) > 0) streak += 1
    else if (index === days.length - 1) continue
    else break
  }
  return {
    cells,
    month: { notes: sum(data?.notes), edits: sum(data?.edits), imports: sum(data?.imports), searches: sum(data?.searches) },
    notesSpark: (data?.notes ?? []).slice(from),
    streak,
  }
}

/** 最近 30 天每天各类活动的折线数据(给活动趋势折线图用)。 */
export interface ActivityTrendData {
  labels: string[]
  notes: number[]
  edits: number[]
  imports: number[]
  searches: number[]
}

export function activityTrend(
  data: { days?: string[]; notes?: number[]; edits?: number[]; imports?: number[]; searches?: number[] } | null | undefined,
): ActivityTrendData {
  const days = data?.days ?? []
  const from = Math.max(0, days.length - 30)
  const labels = days.slice(from).map((day) => day.slice(5))
  return {
    labels,
    notes: (data?.notes ?? []).slice(from),
    edits: (data?.edits ?? []).slice(from),
    imports: (data?.imports ?? []).slice(from),
    searches: (data?.searches ?? []).slice(from),
  }
}
