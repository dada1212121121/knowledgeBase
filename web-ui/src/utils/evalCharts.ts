// 评测页的图表数据:命中率走势(带回落标记)、慢查询耗时走势、逐条结果的名次分布。
// 指标的含义和算法见 utils/evalRuns.ts;这里只把它们整理成图要的形状。
import { dropIndices, shareText, type HBarRow, type LineSeries } from '@kb-ui/index'
import { trendLabels, trendOf, type EvalCase, type EvalRun } from './evalRuns'

/** 命中率比上一次低多少才算「回落」:样本只有几十条,差一条就是 1–2 个百分点,小波动不该吓人。 */
export const DROP_TOLERANCE = 0.02

export interface Trend {
  labels: string[]
  series: LineSeries[]
  /** 因为返回条数(k)和最新一次不同、没法比而没画的次数 */
  skippedK: number
  /** 因为跑的不是同一批用例(黄金集改过 / 随机抽样不同)而没画的次数 */
  skippedSet: number
}

/**
 * 命中率走势。`history` 是新的在前(eval_history 的顺序),图里从旧到新。
 * 前 k 条命中率只在「同一道题」的几次之间有可比性:k 不同的、用例集指纹不同的留空(断开),不拿去比。
 * 老记录没有指纹(实现随机抽样之前),当作同一份黄金集。
 */
export function hitRateTrend(history: EvalRun[], compact: boolean, limit = 8): Trend {
  const runs = trendOf(history, limit)
  const latest = runs[runs.length - 1]
  const latestK = latest?.k ?? 5
  const latestSet = latest?.set_hash ?? null
  const sameSet = (run: EvalRun) => !latestSet || !run.set_hash || run.set_hash === latestSet
  const comparable = runs.map((run) => run.k === latestK && sameSet(run))
  const hitK = runs.map((run, index) => (comparable[index] ? run.hit_at_k : null))
  // 第 1 位命中率与 k 无关,只看是不是同一批用例
  const hit1 = runs.map((run) => (sameSet(run) ? run.hit_at_1 : null))
  return {
    labels: trendLabels(runs, compact),
    skippedK: runs.filter((run) => run.k !== latestK).length,
    skippedSet: runs.filter((run) => run.k === latestK && !sameSet(run)).length,
    series: [
      { name: '第 1 位命中率', values: hit1, flags: dropIndices(hit1, DROP_TOLERANCE), flagNote: '比上一次低' },
      { name: `前 ${latestK} 条命中率`, values: hitK, flags: dropIndices(hitK, DROP_TOLERANCE), flagNote: '比上一次低' },
    ],
  }
}

/** 慢查询耗时走势(95% 的查询在这个毫秒数内完成)。有效点不足两个画不出走势,返回 null。 */
export function latencyTrend(history: EvalRun[], compact: boolean, limit = 8): Trend | null {
  const runs = trendOf(history, limit)
  const values = runs.map((run) => (typeof run.p95_ms === 'number' ? run.p95_ms : null))
  if (values.filter((value) => value !== null).length < 2) return null
  return { labels: trendLabels(runs, compact), skippedK: 0, skippedSet: 0, series: [{ name: '慢查询耗时', values }] }
}

/** 图上的百分比:整数不带小数(轴刻度干净),有小数才留一位(样本小,差 1–2 个点要看得出)。 */
export function chartPercent(value: number): string {
  const text = (value * 100).toFixed(1)
  return `${text.endsWith('.0') ? text.slice(0, -2) : text}%`
}

export const RANK_BUCKETS = [
  { key: 'r1', label: '第 1 位', max: 1 },
  { key: 'r2', label: '第 2 位', max: 2 },
  { key: 'r3', label: '第 3 位', max: 3 },
  { key: 'r5', label: '第 4–5 位', max: 5 },
  { key: 'r10', label: '第 6–10 位', max: 10 },
  { key: 'far', label: '10 位之后', max: Infinity },
  { key: 'miss', label: '没找到', max: -1 },
] as const

/**
 * 逐条结果的名次分布:正确文件到底排在第几。七个桶始终都在(0 也留着),横轴稳定,两次评测之间才好比。
 * 颜色只分三类:第 1 位(绿)、没找到(红)、其余同一个蓝——名字和数字已经说清楚,不靠一排彩虹。
 */
export function rankDistribution(cases: EvalCase[]): HBarRow[] {
  if (!cases.length) return []
  const counts = RANK_BUCKETS.map(() => 0)
  for (const item of cases) {
    const at = item.rank === null ? RANK_BUCKETS.length - 1 : RANK_BUCKETS.findIndex((bucket) => bucket.key !== 'miss' && item.rank! <= bucket.max)
    counts[at] = (counts[at] ?? 0) + 1
  }
  return RANK_BUCKETS.map((bucket, index) => ({
    key: bucket.key,
    label: bucket.label,
    segments: [{ name: bucket.label, value: counts[index] ?? 0, color: bucket.key === 'r1' ? 'var(--viz-2)' : bucket.key === 'miss' ? 'var(--viz-6)' : 'var(--viz-1)' }],
    totalText: `${counts[index]} 条 · ${shareText(counts[index] ?? 0, cases.length)}`,
  }))
}
