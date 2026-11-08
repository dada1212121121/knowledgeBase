// 任务接口(卡 A):分页列表、统计、单个任务的摘要。
// 任务表能累积到上万行,页面一律按页取、统计让服务端算,不再整份拉 job_list。
import { callCapability, type CallOptions, type JobSummary } from './client'

export type JobState = JobSummary['state']

/** AI 总开关关闭时界面上不出现的任务类型(自动提炼 / 审核),和 utils/systemStatus.ts 的 isAiJob 同一份 */
export const AI_JOB_KINDS = ['evolve', 'extract', 'review'] as const

export interface JobListQuery {
  states?: JobState[]
  kinds?: string[]
  exclude_kinds?: string[]
  collection?: string
  page?: number
  page_size?: number
}

export interface JobPage {
  jobs: JobSummary[]
  total: number
  page: number
  page_size: number
}

/** 任务序列里的一个桶(`at` 是桶的起点,毫秒) */
export interface JobBucket {
  at: number
  created: number
  done: number
  failed: number
  canceled: number
  avg_ms: number | null
  /** 桶结束时还在排队的任务数 */
  queue_depth: number
}
export interface JobSeries {
  range: string
  start: number
  step_ms: number
  buckets: JobBucket[]
}
export type JobSeriesRange = '24h' | '7d' | '30d'

/** 一个 collection 的待补向量队列 */
export interface PendingCollection {
  collection: string
  chunks: number
  files: number
  oldest_enqueued_at: number | null
}

/** 待补向量队列汇总(块数 / 文件数 / 最老等待 / 速率 / ETA) */
export interface PendingOverview {
  chunks: number
  files: number
  oldest_enqueued_at: number | null
  oldest_age_secs: number | null
  rate_per_sec: number | null
  eta_secs: number | null
  collections: PendingCollection[]
}

export interface JobStats {
  total: number
  by_state: Partial<Record<JobState, number>>
  kinds: { kind: string; count: number }[]
  recent: { hours: number; since: number; done: number; failed: number; canceled: number; avg_ms: number | null }
  queue: { oldest_queued_at: number | null; first_running: { kind: string; collection: string | null } | null }
  durations: { edges_ms: number[]; buckets: number[]; count: number; median_ms: number | null; p95_ms: number | null }
  /** 文本优先阶段留下的待补向量队列;老接口没有这个字段时按空队列处理 */
  pending?: PendingOverview
  /** 请求时带了 range 才有 */
  series?: JobSeries
}

/** 摘要模式下的任务:payload / checkpoint 是解析并截短过的 JSON(超过 10 项的数组写成 {total, items}) */
export interface JobBrief extends JobSummary {
  priority?: number
  payload: Record<string, unknown> | string | null
  checkpoint: Record<string, unknown> | string | null
}

/** 一个文件在一次任务里的变化(后端 `FileChange` 的字符串值,改名要一起改) */
export type FileChange = 'new' | 'update' | 'meta' | 'delete' | 'skip' | 'error'

/** 任务处理过的单个文件(job_files 表的一行) */
export interface JobFileRow {
  path: string
  change: FileChange
  /** 新写入 / 重新嵌入的块数 */
  chunks: number
  /** 只更新元数据的块数 */
  meta_chunks: number
  /** 删掉的旧块数 */
  deleted_chunks: number
  /** 失败原因(change = error 时有) */
  error: string | null
  done_at: number
}

export interface JobFilesPage {
  job_id: string
  /** 这个任务一共处理了多少个文件(不是本页条数) */
  total: number
  page: number
  page_size: number
  /** 每种变化的条数:只包含出现过的类型,缺省按 0 看 */
  counts: Partial<Record<FileChange, number>>
  items: JobFileRow[]
}

/**
 * 一个任务处理过的文件清单(分页)。
 * 摘要模式(job_get)的数组最多 10 项,全量索引几千个文件只能靠这个能力翻页;
 * 老任务(逐文件记录上线前跑完的)返回空清单,调用方回退到任务参数里的路径。
 */
export const jobFiles = (id: string, page = 1, pageSize = 200, options: JobCallOptions = {}) =>
  callCapability<JobFilesPage>('job_files', { id, page, page_size: pageSize }, options)

/** 空数组 / 空值不发:请求体越短越好,也和后端的「不给 = 不限」一致 */
function compact(query: JobListQuery): Record<string, unknown> {
  return Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined && value !== '' && !(Array.isArray(value) && !value.length)))
}

/** 管理员只读查看:目标用户 id 走请求头,只在这个子树里显式传 */
export type JobCallOptions = Pick<CallOptions, 'adminView'>

export const jobList = (query: JobListQuery = {}, options: JobCallOptions = {}) => callCapability<JobPage>('job_list', compact(query), options)
export const jobStats = (query: Pick<JobListQuery, 'exclude_kinds' | 'collection'> & { range?: JobSeriesRange } = {}, options: JobCallOptions = {}) =>
  callCapability<JobStats>('job_stats', compact(query), options)
export const jobBrief = (id: string, options: JobCallOptions = {}) =>
  callCapability<{ job: JobBrief }>('job_get', { id, brief: true }, options).then((result) => result.job)

/** 摘要里的数组:原样的数组,或超长时的 {total, items} */
export function briefCount(value: unknown): number | null {
  if (Array.isArray(value)) return value.length
  if (value && typeof value === 'object' && typeof (value as { total?: unknown }).total === 'number') return (value as { total: number }).total
  return null
}
export function briefItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object' && Array.isArray((value as { items?: unknown }).items)) return (value as { items: unknown[] }).items
  return []
}
