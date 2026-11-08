// 近期活动的汇总:热力格子、近 30 天合计、迷你线、连续天数、活动趋势。
import { describe, expect, it } from 'vitest'
import { activityTrend, summarizeActivity } from './home'

const days = (count: number) => Array.from({ length: count }, (_, index) => `2026-10-${String(index + 1).padStart(2, '0')}`)
const zeros = (count: number) => Array.from({ length: count }, () => 0)

describe('summarizeActivity', () => {
  it('格子的活动量 = 新建 + 编辑 + 导入 + 检索;合计只算最后 30 天', () => {
    const n = 40
    const notes = zeros(n)
    const edits = zeros(n)
    notes[2] = 5 // 窗口之外(前 10 天)的不进月合计,但在格子里
    notes[39] = 2
    edits[39] = 3
    const got = summarizeActivity({ days: days(n), notes, edits, imports: zeros(n), searches: zeros(n) })
    expect(got.cells).toHaveLength(40)
    expect(got.cells[2]!.value).toBe(5)
    expect(got.cells[39]).toEqual({ date: '2026-10-40', value: 5 })
    expect(got.month).toEqual({ notes: 2, edits: 3, imports: 0, searches: 0 })
    expect(got.notesSpark).toHaveLength(30)
    expect(got.notesSpark.at(-1)).toBe(2)
  })

  it('连续天数:今天还没有活动时从昨天往前算,中间断了就停', () => {
    const n = 10
    const searches = zeros(n)
    for (const at of [3, 4, 5, 6, 7, 8]) searches[at] = 1 // 今天(下标 9)没有
    expect(summarizeActivity({ days: days(n), searches }).streak).toBe(6)
    searches[9] = 1
    expect(summarizeActivity({ days: days(n), searches }).streak).toBe(7)
    searches[6] = 0
    expect(summarizeActivity({ days: days(n), searches }).streak).toBe(3)
    expect(summarizeActivity({ days: days(n), searches: zeros(n) }).streak).toBe(0)
  })

  it('没有数据 / 缺数组:不报错,全是 0', () => {
    expect(summarizeActivity(null)).toEqual({ cells: [], month: { notes: 0, edits: 0, imports: 0, searches: 0 }, notesSpark: [], streak: 0 })
    expect(summarizeActivity({ days: days(3) }).cells.map((cell) => cell.value)).toEqual([0, 0, 0])
  })
})

describe('activityTrend', () => {
  it('截取最近 30 天的标签与四类活动序列', () => {
    const n = 35
    const notes = zeros(n)
    notes[34] = 4
    const got = activityTrend({ days: days(n), notes, edits: zeros(n), imports: zeros(n), searches: zeros(n) })
    expect(got.labels).toHaveLength(30)
    expect(got.labels[0]).toBe('10-06')
    expect(got.labels[29]).toBe('10-35')
    expect(got.notes).toHaveLength(30)
    expect(got.notes[29]).toBe(4)
  })

  it('空数据时不崩溃', () => {
    expect(activityTrend(null)).toEqual({ labels: [], notes: [], edits: [], imports: [], searches: [] })
  })
})
