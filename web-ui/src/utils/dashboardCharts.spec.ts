// 仪表盘内容片段占比:取前几个、其余并成「其它」、颜色跟着项目走。
import { describe, expect, it } from 'vitest'
import { shareDonut } from './dashboardCharts'

const color = (name: string) => `var(--c-${name})`
const entry = (name: string, rows: number) => ({ name, rows })

describe('shareDonut', () => {
  it('按内容片段数从多到少排,颜色用调用方给的项目色', () => {
    const items = shareDonut([entry('a', 10), entry('b', 30), entry('c', 20)], color)
    expect(items.map((item) => item.name)).toEqual(['b', 'c', 'a'])
    expect(items.map((item) => item.color)).toEqual(['var(--c-b)', 'var(--c-c)', 'var(--c-a)'])
  })

  it('同样多时按名字排,顺序稳定(刷新一次不会换位置)', () => {
    expect(shareDonut([entry('z', 5), entry('a', 5)], color).map((item) => item.name)).toEqual(['a', 'z'])
  })

  it('超过上限的并成「其它 N 个项目」,用中性灰,数量是它们的总和', () => {
    const many = Array.from({ length: 9 }, (_, index) => entry(`p${index}`, 100 - index))
    const items = shareDonut(many, color, 5)
    expect(items).toHaveLength(6)
    const other = items.at(-1)!
    expect(other.name).toBe('其它 4 个项目')
    expect(other.other).toBe(true)
    expect(other.color).toBeUndefined()
    expect(other.value).toBe(95 + 94 + 93 + 92)
  })

  it('只比上限多一个项目时直接列出,不并成「其它 1 个项目」', () => {
    const items = shareDonut(Array.from({ length: 6 }, (_, index) => entry(`p${index}`, 10 + index)), color, 5)
    expect(items).toHaveLength(6)
    expect(items.some((item) => item.other)).toBe(false)
  })

  it('内容片段是 0 的项目不列', () => {
    expect(shareDonut([entry('a', 0), entry('b', 3)], color).map((item) => item.name)).toEqual(['b'])
  })

  it('没有项目返回空数组', () => {
    expect(shareDonut([], color)).toEqual([])
  })

  it('不改动传进来的数组', () => {
    const input = [entry('a', 1), entry('b', 2)]
    shareDonut(input, color)
    expect(input.map((item) => item.name)).toEqual(['a', 'b'])
  })
})
