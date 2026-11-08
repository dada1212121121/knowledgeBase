// 存储与用量的纯逻辑:占用分项、使用率与告警线、排序筛选、AI 额度的文字和 UTC 日期。
// 和界面分开,方便单测;界面只负责把这些结果画出来。
import type { LlmUsageRow, StorageOverview, StorageRow } from '@/api/usage'
import { formatBytes } from '@/utils/accountForms'

/** 占用达到上限的 90% 就告警(设计规范、产品要求)。 */
export const WARN_PERCENT = 90

/** ok 正常;warn 接近上限;over 已用完 / 超额;unlimited 没有上限(上限为 0)。 */
export type Level = 'ok' | 'warn' | 'over' | 'unlimited'

/**
 * 已用 / 上限 → 告警级别。上限 0 表示不限(后端存储配额与每日额度都是这个约定),不算告警。
 * 用整数比较(`used*100 >= limit*90`)而不是浮点比例,免得 90% 恰好的那一格被舍入误判。
 */
export function levelOf(used: number, limit: number): Level {
  if (!(limit > 0)) return 'unlimited'
  if (used >= limit) return 'over'
  if (used * 100 >= limit * WARN_PERCENT) return 'warn'
  return 'ok'
}

/** 使用率文字:`64%`;不足 1% 写 `<1%`(有占用却显示 0% 会让人以为没统计到);不限返回空串。 */
export function percentText(used: number, limit: number): string {
  if (!(limit > 0)) return ''
  if (used <= 0) return '0%'
  const percent = (used / limit) * 100
  if (percent < 1) return '<1%'
  return `${Math.round(percent)}%`
}

/** 进度条宽度 0–100;不限或没有占用都是 0,超额封顶 100(超出的部分用颜色和文字说)。 */
export function barPercent(used: number, limit: number): number {
  if (!(limit > 0) || used <= 0) return 0
  return Math.min(100, (used / limit) * 100)
}

/** 占用分项:界面上的四类。笔记 = 元数据库;原件 = 原始文件 + 还没处理完的上传分片。 */
export interface StorageParts {
  notes: number
  originals: number
  vectors: number
  workspace: number
}

export const PART_LABELS: { key: keyof StorageParts; label: string; hint: string }[] = [
  { key: 'notes', label: '笔记', hint: '笔记正文、批注和文档信息(元数据库)' },
  { key: 'originals', label: '原件', hint: '上传的原始文件,含还没处理完的上传分片' },
  { key: 'vectors', label: '向量索引', hint: '让内容能被搜到的索引,用户看不见但计入配额,通常是原文的 2–5 倍' },
  // 术语表叫「代理工作目录」;名字里不带 AI,AI 总开关关掉后这一列的字样也不用藏
  { key: 'workspace', label: '代理工作目录', hint: '外部编码代理读写文件的地方,有大小上限,满了要先清理' },
]

type PartSource = Pick<StorageRow, 'sources_bytes' | 'uploads_bytes' | 'vectors_bytes' | 'meta_bytes' | 'workspace_bytes'>

export function partsOf(row: PartSource): StorageParts {
  return {
    notes: row.meta_bytes,
    originals: row.sources_bytes + row.uploads_bytes,
    vectors: row.vectors_bytes,
    workspace: row.workspace_bytes,
  }
}

/** 一个知识库属于谁:昵称优先,再用户名;账号已被删除的知识库后端给不出名字。 */
export function ownerName(row: Pick<StorageRow, 'display_name' | 'username'>): string {
  return row.display_name?.trim() || row.username || '已删除的账号'
}
export const ownerHandle = (row: Pick<StorageRow, 'username'>): string => (row.username ? `@${row.username}` : '')

export type StorageSort = 'total' | 'ratio' | 'vectors' | 'name' | 'measured'

export const SORT_LABELS: { value: StorageSort; label: string }[] = [
  { value: 'total', label: '总占用' },
  { value: 'ratio', label: '使用率' },
  { value: 'vectors', label: '向量索引' },
  { value: 'name', label: '用户名' },
  { value: 'measured', label: '统计时间' },
]

/** 使用率;不限的人排在有上限的人后面(当作 -1),方便「按使用率」把快满的排前面。 */
const ratioKey = (row: StorageRow) => (row.limit_bytes > 0 ? row.total_bytes / row.limit_bytes : -1)

/** 排序(不改原数组)。`desc` 为大的在前;名字按中文拼音序,同值再按名字稳定排。 */
export function sortStorage(rows: StorageRow[], key: StorageSort, desc: boolean): StorageRow[] {
  const sign = desc ? -1 : 1
  const byName = (a: StorageRow, b: StorageRow) => ownerName(a).localeCompare(ownerName(b), 'zh-CN')
  const pick: Record<StorageSort, (a: StorageRow, b: StorageRow) => number> = {
    total: (a, b) => a.total_bytes - b.total_bytes,
    ratio: (a, b) => ratioKey(a) - ratioKey(b),
    vectors: (a, b) => a.vectors_bytes - b.vectors_bytes,
    name: byName,
    measured: (a, b) => a.measured_at - b.measured_at,
  }
  return [...rows].sort((a, b) => sign * pick[key](a, b) || byName(a, b))
}

export interface StorageFilter {
  query: string
  /** 只看接近上限或已超额的。 */
  onlyAlerts: boolean
}

export function filterStorage(rows: StorageRow[], filter: StorageFilter): StorageRow[] {
  const needle = filter.query.trim().toLowerCase()
  return rows.filter((row) => {
    if (filter.onlyAlerts && !['warn', 'over'].includes(levelOf(row.total_bytes, row.limit_bytes))) return false
    if (!needle) return true
    return `${row.username ?? ''} ${row.display_name ?? ''}`.toLowerCase().includes(needle)
  })
}

/** 有多少人接近上限 / 已经超额。 */
export function alertCounts(rows: StorageRow[]): { warn: number; over: number } {
  let warn = 0
  let over = 0
  for (const row of rows) {
    const level = levelOf(row.total_bytes, row.limit_bytes)
    if (level === 'warn') warn += 1
    else if (level === 'over') over += 1
  }
  return { warn, over }
}

export type DiskLevel = 'ok' | 'warn' | 'paused'
/** 磁盘状态直接用服务端算好的标志(它知道保留值),已暂停优先于预警。 */
export function diskLevel(disk: StorageOverview['disk']): DiskLevel {
  if (disk.paused) return 'paused'
  if (disk.warn) return 'warn'
  return 'ok'
}

export const gbText = (gb: number) => `${gb.toLocaleString('en-US')} GB`

/** 向量索引占全站占用的百分比(取整);全站没有占用时为 0。 */
export function vectorShare(totals: StorageOverview['totals']): number {
  return totals.total_bytes > 0 ? Math.round((totals.vectors_bytes / totals.total_bytes) * 100) : 0
}

export { formatBytes }

// ---------------------------------------------------------------- AI 额度

const group = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const trimDecimal = (x: number) => (x >= 100 ? String(Math.round(x)) : String(Number(x.toFixed(1))))

/** token 数的人话:`9,876` / `6.8 万` / `20 万` / `1.2 亿`。 */
export function tokensText(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 10_000) return group(Math.round(n))
  if (n < 100_000_000) return `${trimDecimal(n / 10_000)} 万`
  return `${trimDecimal(n / 100_000_000)} 亿`
}

/** 额度行:`已用 6.8 万 / 共 20 万`;不限是 `已用 6.8 万 · 不限`(GLOSSARY:不只放一个百分比)。 */
export function quotaText(used: number, limit: number): string {
  return limit > 0 ? `已用 ${tokensText(used)} / 共 ${tokensText(limit)}` : `已用 ${tokensText(used)} · 不限`
}

export interface LlmAlerts {
  over: number
  warn: number
  users: number
}
export function llmAlertCounts(rows: LlmUsageRow[]): LlmAlerts {
  let over = 0
  let warn = 0
  for (const row of rows) {
    const level = levelOf(row.tokens, row.limit)
    if (level === 'over') over += 1
    else if (level === 'warn') warn += 1
  }
  return { over, warn, users: rows.length }
}

/** 排行里的名字,账号被删除时后端给 null。 */
export const llmOwnerName = (row: Pick<LlmUsageRow, 'display_name' | 'username'>): string =>
  row.display_name?.trim() || row.username || '已删除的账号'

/**
 * 模型调用用途的中文名，首页管理员卡和「模型用量趋势」共用这一份。
 * 键是后端记账用的 purpose（`llm_gate::Purpose::as_str` 等）；没登记的原样显示，后端加用途时要在这里补名字。
 */
export const LLM_PURPOSE_LABELS: Readonly<Record<string, string>> = {
  extract: '自动提炼',
  review: '自动审核',
  agent: '助手对话',
  write: '写作助手',
  consolidate: '主题归纳',
  web_extract: '网页规范化',
  deep_search: '深度检索',
  query_enhance: '检索增强',
  test: '连接测试',
}

export const llmPurposeLabel = (purpose: string): string => LLM_PURPOSE_LABELS[purpose] ?? purpose

// ---------------------------------------------------------------- 站点日期
// 后端的用量按站点时区(`[site] timezone`,默认 Asia/Shanghai)的自然日记账,
// 额度也在站点时区的 0 点重置。管理员选日期时选的就是这个日期。
import { dayKey, shiftDay as shiftSiteDay } from './time'

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** 毫秒时间戳所在的站点日期 `YYYY-MM-DD`。 */
export const siteDay = (ms: number): string => dayKey(ms)

/** 是不是一个真实存在的日期(2026-02-30 不是)。 */
export function isDay(text: string): boolean {
  const match = DAY_RE.exec(text)
  if (!match) return false
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/** 前后挪若干天;输入不是合法日期时原样返回。 */
export function shiftDay(day: string, delta: number): string {
  return isDay(day) ? shiftSiteDay(day, delta) : day
}
