import { monthDayText } from './time'
// AI 管家会话列表用的小工具(纯函数,便于单测)。

import { PATHS } from '@/router/paths'

/** 一条会话的摘要(与后端 `agent_sessions` 的字段一致)。 */
export interface AgentSessionSummary {
  session_id: string
  title: string
  /** 会话所属项目(从工具参数推断;空 = 未归属)。 */
  project: string
  /** 后端:`builtin` / `acp`。 */
  backend?: string
  /** 是否置顶。 */
  pinned: boolean
  created_at: number
  last_at: number
  messages: number
}

/** 工具结果里可以点开的东西(与后端 `AgentRef` 一致)。 */
export interface AgentRef {
  kind: 'item' | 'collection' | 'project' | 'batch' | 'job' | 'ingest'
  id: string
  label: string
  collection?: string
  source?: string
}

/** 引用 → 站内路由(条目直接落到浏览器并打开它)。 */
export function refLink(ref: AgentRef): { path: string; query?: Record<string, string> } {
  switch (ref.kind) {
    case 'item':
      return {
        path: PATHS.kb,
        query: {
          ...(ref.collection ? { collection: ref.collection } : {}),
          item: ref.id,
        },
      }
    case 'collection':
      return { path: PATHS.kb, query: { collection: ref.collection ?? ref.id } }
    case 'project':
      return { path: PATHS.projects }
    case 'batch':
      return { path: PATHS.audit, query: { tab: 'batches', batch: ref.id } }
    case 'job':
      return { path: PATHS.tasks, query: { job: ref.id } }
    case 'ingest':
      return { path: PATHS.importQueue }
  }
}

/** 会话列表的项目筛选项:全部 + 出现过的项目。 */
export function projectOptions(sessions: AgentSessionSummary[]): { value: string; label: string }[] {
  const seen = new Set<string>()
  for (const session of sessions) {
    const project = session.project?.trim()
    if (project) seen.add(project)
  }
  return [
    { value: '', label: '全部项目' },
    ...[...seen].sort().map((project) => ({ value: project, label: project })),
  ]
}

/** 列表里的标题:空标题用「新会话」,过长截断到 40 字。 */
export function sessionLabel(title: string): string {
  const text = (title ?? '').trim()
  if (!text) return '新会话'
  const chars = [...text]
  return chars.length > 40 ? `${chars.slice(0, 40).join('')}…` : text
}

/** 相对时间:刚刚 / N 分钟前 / N 小时前 / N 天前,超过一周显示月-日。 */
export function timeAgo(at: number, now = Date.now()): string {
  if (!at) return ''
  const diff = Math.max(0, now - at)
  const minute = 60_000
  if (diff < minute) return '刚刚'
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} 小时前`
  if (diff < 7 * 24 * 60 * minute) return `${Math.floor(diff / (24 * 60 * minute))} 天前`
  return monthDayText(at, now)
}

/** 会话历史里的一条原始消息(后端 `agent_history` 的形状)。 */
export interface HistoryMessage {
  role: string
  content_json: string
}

/** 还原后的聊天气泡。 */
export interface RestoredEntry {
  role: 'user' | 'assistant' | 'system'
  text: string
  trace?: string[]
  refs?: AgentRef[]
  cards?: Record<string, unknown>[]
  /** 这一轮失败过(展示成一条系统提示)。 */
  failed?: boolean
}

/**
 * 把 `agent_history` 还原成气泡:用户 / 助手 / 系统(失败提示),
 * 计划卡片挂到上一条助手消息上;工具轨迹与引用都保留。
 */
export function restoreEntries(messages: HistoryMessage[]): RestoredEntry[] {
  const out: RestoredEntry[] = []
  for (const message of messages) {
    let parsed: Record<string, unknown> = {}
    try {
      parsed = JSON.parse(message.content_json) as Record<string, unknown>
    } catch {
      continue
    }
    if (message.role === 'user') {
      out.push({ role: 'user', text: String(parsed.text ?? '') })
    } else if (message.role === 'assistant') {
      const error = typeof parsed.error === 'string' ? parsed.error : ''
      if (error) {
        out.push({ role: 'system', text: `上一轮失败:${error}`, failed: true })
      } else {
        out.push({
          role: 'assistant',
          text: String(parsed.text ?? ''),
          trace: Array.isArray(parsed.trace) ? (parsed.trace as string[]) : [],
          refs: Array.isArray(parsed.refs) ? (parsed.refs as AgentRef[]) : [],
        })
      }
    } else if (message.role === 'plan' && parsed.card) {
      const card = parsed.card as Record<string, unknown>
      const last = out[out.length - 1]
      if (last && last.role === 'assistant') {
        last.cards = [...(last.cards ?? []), card]
      } else {
        out.push({ role: 'assistant', text: '', cards: [card] })
      }
    }
  }
  return out
}
