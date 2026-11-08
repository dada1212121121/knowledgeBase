// 资源曲线与活动趋势的接口(卡 D):给系统状态、首页、系统概览的图表用。
import { callCapability } from './client'

export type MetricsRange = '1h' | '24h' | '7d' | '30d'

/** 一个时间点的资源读数;1 小时的点是 10 秒一个,更长的是时间桶的平均(CPU 另有桶内最大值) */
export interface MetricPoint {
  at: number
  /** 本机 CPU 使用率 0–1 */
  cpu: number
  cpu_max: number
  /** 已用内存 / 总量(字节,已用不含可回收的缓存) */
  mem_used: number
  mem_total: number
  load1: number
  /** 数据盘已用 / 总量(字节) */
  disk_used: number
  disk_total: number
  /** 本服务进程占整机 CPU 的比例 0–1,以及常驻内存(字节) */
  proc_cpu: number
  proc_rss: number
}

export interface MetricsSeries {
  range: MetricsRange
  step_ms: number
  since: number
  until: number
  cores: number
  points: MetricPoint[]
  /** 最新一个读数(不满一分钟的部分还没落库,看这个) */
  now: MetricPoint | null
}

export const metricsSeries = (range: MetricsRange = '1h') => callCapability<MetricsSeries>('metrics_series', { range })

/** 最近若干天每天的活动;每个数组长度都等于 days.length,最后一天是今天 */
export interface ActivitySeries {
  days: string[]
  notes: number[]
  edits: number[]
  imports: number[]
  imports_done: number[]
  searches: number[]
  jobs_done: number[]
  ai_tokens: number[]
}

export const activitySeries = (days = 30) => callCapability<ActivitySeries>('activity_series', { days })

/** 磁盘按近 7 天的增长速度外推还能撑多久(毫秒);增长为 0 或在变小、数据不够时返回 null(不写「预计写满」) */
export function diskFullIn(points: Pick<MetricPoint, 'at' | 'disk_used' | 'disk_total'>[]): number | null {
  if (points.length < 2) return null
  const first = points[0]!
  const last = points[points.length - 1]!
  const spanMs = last.at - first.at
  const grown = last.disk_used - first.disk_used
  // 不足一天的数据外推太不准;增长为 0 或变小不预测
  if (spanMs < 86_400_000 || grown <= 0) return null
  const perMs = grown / spanMs
  const left = last.disk_total - last.disk_used
  return left <= 0 ? 0 : left / perMs
}

/** 导入概况(导入页):各状态的文件数、最近每小时进来 / 成功 / 失败的文件数、失败原因 Top */
export interface IngestStats {
  by_state: { state: string; count: number }[]
  start: number
  step_ms: number
  buckets: { at: number; total: number; done: number; failed: number }[]
  top_errors: { error: string; count: number }[]
}
export const ingestStats = (hours = 24) => callCapability<IngestStats>('ingest_stats', { hours })

/** 每个集合里文件的状态分布(项目页) */
export interface ProjectFileStats {
  collections: { collection: string; statuses: Record<string, number>; total: number }[]
}
export const projectFileStats = () => callCapability<ProjectFileStats>('project_file_stats', {})

/** 全站 AI 用量趋势(管理员,存储与用量页):每个用途一条按天的 token 序列 */
export interface LlmUsageSeries {
  days: string[]
  purposes: string[]
  series: Record<string, number[]>
  totals: number[]
}
export const llmUsageSeries = (days = 30) => callCapability<LlmUsageSeries>('llm_usage_series', { days })

/** 审计概况(审计页):周几 × 几点的调用次数(周一在最上),最常用的能力。不含页面自动刷新用的读取。 */
export interface AuditStats {
  days: number
  heat: number[][]
  top: { capability: string; count: number; failed: number }[]
  total: number
  failed: number
}
export const auditStats = (days = 30) => callCapability<AuditStats>('audit_stats', { days })
