// 评测图表的数据整形:命中率走势(含回落标记)、慢查询耗时走势、名次分布。
import { describe, expect, it } from 'vitest'
import { chartPercent, hitRateTrend, latencyTrend, rankDistribution, RANK_BUCKETS } from './evalCharts'
import type { EvalCase, EvalRun } from './evalRuns'

const AT = Date.UTC(2026, 5, 10, 12, 0, 0)
const DAY = 86_400_000
// 历史是「新的在前」,和 eval_history 一致
const run = (daysAgo: number, hit1: number, hitK: number, extra: Partial<EvalRun> = {}): EvalRun => ({
  at: AT - daysAgo * DAY,
  run_id: `r${daysAgo}`,
  hit_at_1: hit1,
  hit_at_k: hitK,
  k: 5,
  mrr: 0.8,
  ...extra,
})

describe('chartPercent', () => {
  it('整数不带小数,有小数留一位,没有浮点尾巴', () => {
    expect(chartPercent(0.9)).toBe('90%')
    expect(chartPercent(0.07)).toBe('7%')
    expect(chartPercent(0.943)).toBe('94.3%')
    expect(chartPercent(1)).toBe('100%')
    expect(chartPercent(0)).toBe('0%')
  })
})

describe('hitRateTrend', () => {
  it('时间从旧到新,两条线:第 1 位命中率、前 k 条命中率', () => {
    const trend = hitRateTrend([run(0, 0.9, 0.96), run(1, 0.85, 0.95), run(2, 0.8, 0.9)], false)
    expect(trend.labels).toHaveLength(3)
    expect(trend.series.map((item) => item.name)).toEqual(['第 1 位命中率', '前 5 条命中率'])
    expect(trend.series[0]!.values).toEqual([0.8, 0.85, 0.9])
    expect(trend.series[1]!.values).toEqual([0.9, 0.95, 0.96])
  })

  it('比上一次低了超过 2 个百分点的点标成回落,小幅波动不标', () => {
    const trend = hitRateTrend([run(0, 0.84, 0.96), run(1, 0.9, 0.95), run(2, 0.85, 0.94)], false)
    // 旧→新:0.85, 0.90, 0.84;最后一次比 0.90 低 6 个点
    expect(trend.series[0]!.flags).toEqual([2])
    // 前 k 条命中率:0.94, 0.95, 0.96 一路上升,没有回落
    expect(trend.series[1]!.flags).toEqual([])
    const wobble = hitRateTrend([run(0, 0.89, 0.9), run(1, 0.9, 0.9)], false)
    expect(wobble.series[0]!.flags).toEqual([])
  })

  it('返回条数(k)和最新一次不同的那几次,前 k 条命中率不画(两次的 k 不同,数字不能比)', () => {
    const trend = hitRateTrend([run(0, 0.9, 0.96, { k: 5 }), run(1, 0.85, 0.99, { k: 10 }), run(2, 0.8, 0.9, { k: 5 })], false)
    expect(trend.series[1]!.values).toEqual([0.9, null, 0.96])
    // 断开的点前后不会被当成「相邻」去比较回落
    expect(trend.series[1]!.flags).toEqual([])
    expect(trend.skippedK).toBe(1)
  })

  it('最多取最近 limit 次', () => {
    const many = Array.from({ length: 12 }, (_, index) => run(index, 0.5, 0.6))
    expect(hitRateTrend(many, false, 8).labels).toHaveLength(8)
  })

  it('没有历史也不报错', () => {
    const trend = hitRateTrend([], false)
    expect(trend.labels).toEqual([])
    expect(trend.series[0]!.values).toEqual([])
  })
})

describe('latencyTrend', () => {
  it('取每次的 p95 耗时;缺的(老记录)是 null', () => {
    const trend = latencyTrend([run(0, 0.9, 0.9, { p95_ms: 212 }), run(1, 0.9, 0.9), run(2, 0.9, 0.9, { p95_ms: 34 })], false)!
    expect(trend.series[0]!.values).toEqual([34, null, 212])
    expect(trend.series[0]!.name).toBe('慢查询耗时')
  })

  it('不足两个有效点画不出走势,返回 null', () => {
    expect(latencyTrend([run(0, 0.9, 0.9, { p95_ms: 100 }), run(1, 0.9, 0.9)], false)).toBeNull()
    expect(latencyTrend([], false)).toBeNull()
  })
})

describe('rankDistribution', () => {
  const cases = (ranks: (number | null)[]): EvalCase[] => ranks.map((rank, index) => ({ query: `q${index}`, rank }))

  it('分桶:第 1、2、3 位,4–5,6–10,10 之后,没找到;每桶都在(0 也留着)', () => {
    const rows = rankDistribution(cases([1, 1, 1, 2, 3, 5, 7, 12, null, null]))
    expect(rows.map((row) => row.key)).toEqual(RANK_BUCKETS.map((bucket) => bucket.key))
    expect(rows.map((row) => row.segments[0]!.value)).toEqual([3, 1, 1, 1, 1, 1, 2])
  })

  it('每行右边写「N 条 · 占比」,占比相对全部查询', () => {
    const rows = rankDistribution(cases([1, 1, 1, 2]))
    expect(rows[0]!.totalText).toBe('3 条 · 75%')
    expect(rows[1]!.totalText).toBe('1 条 · 25%')
    expect(rows[6]!.totalText).toBe('0 条 · 0%')
  })

  it('第 1 位用绿色系、没找到用红色系,其余同一个颜色(靠名字区分,不靠一排彩虹)', () => {
    const rows = rankDistribution(cases([1, 2, null]))
    const colors = rows.map((row) => row.segments[0]!.color)
    expect(colors[0]).toBe('var(--viz-2)')
    expect(colors[6]).toBe('var(--viz-6)')
    expect(new Set(colors.slice(1, 6))).toEqual(new Set(['var(--viz-1)']))
  })

  it('没有逐条结果时返回空数组(调用方据此不画)', () => {
    expect(rankDistribution([])).toEqual([])
  })
})
