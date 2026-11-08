// 任务图表的数据整形:状态分布、用时分段、类型下拉的合并。数字本身由服务端 job_stats 算(见 kb-meta 的对拍测试)。
import { describe, expect, it } from 'vitest'
import { durationDistribution, kindGroups, stateBreakdown } from './jobCharts'

describe('stateBreakdown', () => {
  it('按需要关注的程度排,中文名,数量为 0 的状态不列', () => {
    const items = stateBreakdown({ done: 2, failed: 1, running: 1, queued: 0 })
    expect(items.map((item) => item.name)).toEqual(['运行中', '完成', '失败'])
    expect(items.map((item) => item.value)).toEqual([1, 2, 1])
  })

  it('完成绿、失败红、运行蓝,已取消用中性灰', () => {
    const items = stateBreakdown({ running: 1, done: 1, failed: 1, canceled: 1 })
    expect(Object.fromEntries(items.map((item) => [item.name, item.color]))).toEqual({
      运行中: 'var(--viz-1)',
      完成: 'var(--viz-2)',
      失败: 'var(--viz-6)',
      已取消: 'var(--viz-other)',
    })
  })

  it('没有任务返回空数组', () => {
    expect(stateBreakdown({})).toEqual([])
  })
})

describe('durationDistribution', () => {
  it('五段始终都在(0 也留着),每行写「N 个 · 占比」', () => {
    const rows = durationDistribution([2, 0, 1, 0, 1])
    expect(rows).toHaveLength(5)
    expect(rows.map((row) => row.label)).toEqual(['10 秒内', '10 秒–1 分钟', '1–5 分钟', '5–30 分钟', '超过 30 分钟'])
    expect(rows.map((row) => row.segments[0]!.value)).toEqual([2, 0, 1, 0, 1])
    expect(rows[0]!.totalText).toBe('2 个 · 50%')
    expect(rows[1]!.totalText).toBe('0 个 · 0%')
  })

  it('一个已完成的都没有返回空数组', () => {
    expect(durationDistribution([0, 0, 0, 0, 0])).toEqual([])
    expect(durationDistribution([])).toEqual([])
  })
})

describe('kindGroups', () => {
  it('按中文名合并:evolve 和 extract 都是「自动提炼」,一个选项带两种类型', () => {
    const groups = kindGroups([{ kind: 'extract' }, { kind: 'index' }, { kind: 'evolve' }])
    expect(groups.find((group) => group.label === '自动提炼')).toEqual({ label: '自动提炼', kinds: ['evolve', 'extract'] })
    expect(groups.filter((group) => group.label === '自动提炼')).toHaveLength(1)
  })

  it('认不出的类型原样当名字', () => {
    expect(kindGroups([{ kind: 'mystery' }])).toEqual([{ label: 'mystery', kinds: ['mystery'] }])
  })
})
