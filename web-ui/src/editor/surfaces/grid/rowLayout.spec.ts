/**
 * 行布局测试：视图行号 ↔ 底表行 / 新行的映射。
 * 这是「插入行 / 删除行」所有适配器共用的一层，错一位会让用户改到别的行，所以逐项对拍一个暴力实现。
 */
import { describe, expect, it } from 'vitest'
import { RowLayout, type InsertedRow } from './rowLayout'

/** 暴力参考：展开成数组再查 */
function brute(baseCount: number, inserted: InsertedRow[], deleted: Set<number>): string[] {
  const out: string[] = []
  for (let row = 0; row <= baseCount; row += 1) {
    for (const item of inserted) if (item.at === row) out.push(`i${item.id}`)
    if (row < baseCount && !deleted.has(row)) out.push(`b${row}`)
  }
  return out
}

const label = (layout: RowLayout, view: number): string => {
  const source = layout.at(view)
  if (!source) return 'null'
  return source.kind === 'base' ? `b${source.row}` : `i${source.inserted.id}`
}

describe('RowLayout', () => {
  it('1. 没有新行、没有删除：视图行号就是底表行号', () => {
    const layout = new RowLayout(5)
    expect(layout.count).toBe(5)
    expect(label(layout, 0)).toBe('b0')
    expect(label(layout, 4)).toBe('b4')
    expect(layout.at(5)).toBeNull()
    expect(layout.at(-1)).toBeNull()
  })

  it('2. 删除的行从视图里消失，后面的行号上移', () => {
    const layout = new RowLayout(5, [], new Set([1, 2]))
    expect(layout.count).toBe(3)
    expect([0, 1, 2].map((view) => label(layout, view))).toEqual(['b0', 'b3', 'b4'])
    expect(layout.viewOfBase(1)).toBe(-1)
    expect(layout.viewOfBase(3)).toBe(1)
  })

  it('3. 新行插在指定底表行之前；等于行数就是加在最后；同位置按数组顺序', () => {
    const inserted: InsertedRow[] = [
      { id: 1, at: 2, values: [] },
      { id: 2, at: 2, values: [] },
      { id: 3, at: 4, values: [] },
      { id: 4, at: 0, values: [] },
    ]
    const layout = new RowLayout(4, inserted)
    expect(layout.count).toBe(8)
    expect(Array.from({ length: 8 }, (_, view) => label(layout, view))).toEqual(['i4', 'b0', 'b1', 'i1', 'i2', 'b2', 'b3', 'i3'])
    expect(layout.viewOfInserted(3)).toBe(7)
    expect(layout.viewOfBase(2)).toBe(5)
  })

  it('4. 删除和新行同位置：新行先于被删行出现，被删行不显示', () => {
    const layout = new RowLayout(3, [{ id: 1, at: 1, values: ['x'] }], new Set([1]))
    expect(Array.from({ length: layout.count }, (_, view) => label(layout, view))).toEqual(['b0', 'i1', 'b2'])
  })

  it('5. 空底表：只有新行也是合法视图', () => {
    const layout = new RowLayout(0, [{ id: 7, at: 0, values: [] }])
    expect(layout.count).toBe(1)
    expect(label(layout, 0)).toBe('i7')
    expect(new RowLayout(0).count).toBe(0)
  })

  it('6. 随机组合与暴力实现逐行一致', () => {
    let seed = 12345
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    for (let round = 0; round < 200; round += 1) {
      const baseCount = random(30)
      const inserted: InsertedRow[] = Array.from({ length: random(8) }, (_, index) => ({ id: index + 1, at: random(baseCount + 1), values: [] }))
      const deleted = new Set<number>(Array.from({ length: random(10) }, () => random(Math.max(1, baseCount))).filter((row) => row < baseCount))
      const layout = new RowLayout(baseCount, inserted, deleted)
      const expected = brute(baseCount, inserted, deleted)
      expect(layout.count).toBe(expected.length)
      expected.forEach((want, view) => expect(label(layout, view)).toBe(want))
      for (let row = 0; row < baseCount; row += 1) {
        const view = expected.indexOf(`b${row}`)
        expect(layout.viewOfBase(row)).toBe(view)
      }
    }
  })

  it('7. 百万行加几千条编辑：段数只和编辑数有关，查询不遍历', () => {
    const deleted = new Set<number>(Array.from({ length: 3000 }, (_, index) => index * 300))
    const inserted: InsertedRow[] = Array.from({ length: 2000 }, (_, index) => ({ id: index + 1, at: index * 450, values: [] }))
    const started = performance.now()
    const layout = new RowLayout(1_000_000, inserted, deleted)
    expect(layout.count).toBe(1_000_000 - 3000 + 2000)
    // 末行一定是底表的最后一行
    expect(label(layout, layout.count - 1)).toBe('b999999')
    expect(layout.baseRuns().length).toBeLessThanOrEqual(2 * (3000 + 2000) + 1)
    expect(performance.now() - started).toBeLessThan(200)
  })
})
